/**
 * WeatherMyTrip — Netlify Serverless Function
 * POST /.netlify/functions/analyze
 *
 * Flow:
 *  1. Validate request body
 *  2. Check Supabase cache completeness for the requested location
 *  3. Cache miss → fetch 20 years of daily data from Open-Meteo archive, upsert in parallel batches
 *  4. Query Supabase for all historical rows for this location
 *  5. Filter by calendar date range (month-day window) in JS
 *  6. If trip dates are within the next 16 days, also fetch ECMWF forecast from Open-Meteo
 *  7. Return cleaned records + optional forecast + server-side compute metrics
 *
 * Environment variables (set in Netlify dashboard → Site config → Env vars):
 *   SUPABASE_URL              your project URL (https://xxx.supabase.co)
 *   SUPABASE_SERVICE_ROLE_KEY service-role key (bypasses RLS for writes)
 *   OPEN_METEO_API_KEY        your customer API key (works for both archive & forecast endpoints)
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

// ── Config ────────────────────────────────────────────────────────────────────

const LOCATIONS = {
  orlando: { name: 'Orlando, FL', lat: 28.5383, lon: -81.3792, tz: 'America/New_York' },
  miami:   { name: 'Miami, FL',   lat: 25.7617, lon: -80.1918, tz: 'America/New_York' },
};

const ARCHIVE_BASE  = 'https://customer-archive-api.open-meteo.com/v1/archive';
const FORECAST_BASE = 'https://customer-api.open-meteo.com/v1/forecast';

const START_YEAR     = 2005;
const END_YEAR       = 2024;
const EXPECTED_DAYS  = (END_YEAR - START_YEAR + 1) * 365;
const CACHE_COMPLETE = Math.floor(EXPECTED_DAYS * 0.95); // ~6939 rows = 95% of 20yr

const BATCH_SIZE   = 500;
const BATCH_CONCUR = 4;

// ── CORS helpers ──────────────────────────────────────────────────────────────

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}

function ok(body, origin) {
  return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(body) };
}

function err(statusCode, message, origin) {
  return { statusCode, headers: corsHeaders(origin), body: JSON.stringify({ error: message }) };
}

// ── Date helpers ──────────────────────────────────────────────────────────────

/**
 * Returns true if (month, day) falls within the calendar window (sm/sd)→(em/ed),
 * correctly handling year-wrap ranges (e.g. Dec 15 – Jan 10).
 */
function inCalendarRange(month, day, sm, sd, em, ed) {
  const mmdd = month * 100 + day;
  const s    = sm    * 100 + sd;
  const e    = em    * 100 + ed;
  return s <= e ? mmdd >= s && mmdd <= e : mmdd >= s || mmdd <= e;
}

// ── Open-Meteo: historical archive fetch + Supabase upsert ───────────────────

async function fetchAndCache(supabase, locationKey, loc) {
  const apiKey = process.env.OPEN_METEO_API_KEY;
  if (!apiKey) throw new Error('OPEN_METEO_API_KEY environment variable is not set.');

  const params = new URLSearchParams({
    latitude:   loc.lat,
    longitude:  loc.lon,
    start_date: `${START_YEAR}-01-01`,
    end_date:   `${END_YEAR}-12-31`,
    daily: [
      'temperature_2m_max',
      'temperature_2m_min',
      'temperature_2m_mean',
      'precipitation_sum',
      'windspeed_10m_max',
      'weather_code',
    ].join(','),
    timezone: loc.tz,
    apikey:   apiKey,
  });

  console.log(`[analyze] Fetching ${START_YEAR}–${END_YEAR} archive for ${locationKey}…`);
  const res = await fetch(`${ARCHIVE_BASE}?${params}`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Open-Meteo archive returned ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const d    = data.daily;
  if (!d?.time) throw new Error('Unexpected Open-Meteo response shape — missing daily.time');

  const rows = d.time.map((date, i) => ({
    location_key:     locationKey,
    obs_date:         date,
    temp_max_c:       d.temperature_2m_max[i]  ?? null,
    temp_min_c:       d.temperature_2m_min[i]  ?? null,
    temp_mean_c:      d.temperature_2m_mean[i] ?? null,
    precipitation_mm: d.precipitation_sum[i]   ?? null,
    wind_max_kmh:     d.windspeed_10m_max[i]   ?? null,
    weather_code:     d.weather_code[i]        ?? null,
  }));

  // Chunk into BATCH_SIZE slices, upsert BATCH_CONCUR at a time
  const chunks = [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) chunks.push(rows.slice(i, i + BATCH_SIZE));

  console.log(`[analyze] Upserting ${rows.length} rows in ${chunks.length} batches (${BATCH_CONCUR} parallel)…`);

  for (let i = 0; i < chunks.length; i += BATCH_CONCUR) {
    const results = await Promise.all(
      chunks.slice(i, i + BATCH_CONCUR).map(chunk =>
        supabase
          .from('weather_observations')
          .upsert(chunk, { onConflict: 'location_key,obs_date', ignoreDuplicates: false })
      )
    );
    for (const { error } of results) {
      if (error) throw new Error(`Supabase upsert error: ${error.message}`);
    }
  }

  console.log(`[analyze] Cache populated for ${locationKey}: ${rows.length} rows.`);
  return rows.length;
}

// ── Open-Meteo: ECMWF forecast fetch (non-fatal) ─────────────────────────────

/**
 * Fetches actual ECMWF/GFS probabilistic forecast from Open-Meteo for the
 * requested trip dates, if they fall within the 16-day forecast window.
 * Returns null if dates are outside the window or if the fetch fails.
 */
async function fetchForecast(loc, startDate, endDate, apiKey) {
  if (!apiKey || !startDate || !endDate) return null;

  try {
    const today          = new Date().toISOString().split('T')[0];
    const maxForecastEnd = new Date(Date.now() + 15 * 86400000).toISOString().split('T')[0];

    // Skip if the trip doesn't overlap the forecast window at all
    if (startDate > maxForecastEnd || endDate < today) return null;

    // Clamp to what the forecast API actually covers
    const fetchStart = startDate < today          ? today          : startDate;
    const fetchEnd   = endDate   > maxForecastEnd ? maxForecastEnd : endDate;

    const params = new URLSearchParams({
      latitude:      loc.lat,
      longitude:     loc.lon,
      start_date:    fetchStart,
      end_date:      fetchEnd,
      daily: [
        'temperature_2m_max',
        'temperature_2m_min',
        'precipitation_probability_max',
        'wind_gusts_10m_max',
        'weather_code',
      ].join(','),
      timezone:      loc.tz,
      forecast_days: 16,
      apikey:        apiKey,
    });

    console.log(`[analyze] Fetching ECMWF forecast ${fetchStart}→${fetchEnd} for ${loc.name}…`);
    const res = await fetch(`${FORECAST_BASE}?${params}`);
    if (!res.ok) {
      console.warn(`[analyze] Forecast API returned ${res.status} — skipping forecast.`);
      return null;
    }

    const data = await res.json();
    const d    = data.daily;
    if (!d?.time) return null;

    return d.time.map((date, i) => ({
      date,
      tempMaxC:      d.temperature_2m_max[i]            ?? null,
      tempMinC:      d.temperature_2m_min[i]            ?? null,
      precipProbPct: d.precipitation_probability_max[i] ?? null, // 0–100 %
      windGustKmh:   d.wind_gusts_10m_max[i]            ?? null,
      weatherCode:   d.weather_code[i]                  ?? null,
    }));
  } catch (e) {
    // Forecast is enrichment only — never fail the whole request for it
    console.warn('[analyze] Forecast fetch failed (non-fatal):', e.message);
    return null;
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

exports.handler = async function (event) {
  const t0     = Date.now();
  const origin = event.headers?.origin || event.headers?.Origin;

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(origin), body: '' };
  if (event.httpMethod !== 'POST')    return err(405, 'Method not allowed — use POST', origin);

  // Parse body
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON body', origin); }

  const {
    location,
    startMonth, startDay,
    endMonth,   endDay,
    riskDays,
    startDate,  // full ISO date, e.g. "2026-07-01" — used for forecast window detection
    endDate,    // full ISO date, e.g. "2026-07-14"
  } = body;

  if (!LOCATIONS[location])
    return err(400, `Unknown location "${location}". Valid: ${Object.keys(LOCATIONS).join(', ')}`, origin);

  if ([startMonth, startDay, endMonth, endDay].some(n => typeof n !== 'number' || n < 1 || n > 31))
    return err(400, 'startMonth, startDay, endMonth, endDay must be integers 1–31', origin);

  const loc = LOCATIONS[location];

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)
    return err(500, 'Supabase environment variables are not configured.', origin);

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  try {
    // 1. Check cache completeness ────────────────────────────────────────────
    const tCache = Date.now();
    const { count, error: countErr } = await supabase
      .from('weather_observations')
      .select('*', { count: 'exact', head: true })
      .eq('location_key', location)
      .gte('obs_date', `${START_YEAR}-01-01`)
      .lte('obs_date', `${END_YEAR}-12-31`);

    if (countErr) throw new Error(`Cache check failed: ${countErr.message}`);
    const cacheCheckMs = Date.now() - tCache;

    const cacheHit = (count || 0) >= CACHE_COMPLETE;

    // 2. Populate cache if needed ─────────────────────────────────────────────
    if (!cacheHit) {
      console.log(`[analyze] Cache miss for ${location} (${count ?? 0}/${CACHE_COMPLETE} rows). Fetching from Open-Meteo…`);
      await fetchAndCache(supabase, location, loc);
    }

    // 3. Query all rows for this location ─────────────────────────────────────
    const tQuery = Date.now();
    const { data: rows, error: fetchErr } = await supabase
      .from('weather_observations')
      .select('obs_date, temp_max_c, temp_min_c, temp_mean_c, precipitation_mm, wind_max_kmh, weather_code')
      .eq('location_key', location)
      .gte('obs_date', `${START_YEAR}-01-01`)
      .lte('obs_date', `${END_YEAR}-12-31`)
      .order('obs_date', { ascending: true })
      .limit(10000); // safely above 20yr × 366 = 7320

    if (fetchErr) throw new Error(`Supabase query failed: ${fetchErr.message}`);
    if (!rows?.length) throw new Error('No data returned from Supabase — cache may be empty.');
    const queryMs = Date.now() - tQuery;

    // 4. Filter to calendar date window
    const records = rows
      .filter(r => {
        const [, mo, dy] = r.obs_date.split('-').map(Number);
        return inCalendarRange(mo, dy, startMonth, startDay, endMonth, endDay);
      })
      .map(r => {
        const [yr, mo, dy] = r.obs_date.split('-').map(Number);
        return {
          date:  r.obs_date, yr, mo, dy,
          tMax:  r.temp_max_c       != null ? +r.temp_max_c       : null,
          tMin:  r.temp_min_c       != null ? +r.temp_min_c       : null,
          tMean: r.temp_mean_c      != null ? +r.temp_mean_c      : null,
          prec:  r.precipitation_mm != null ? +r.precipitation_mm : 0,
          wind:  r.wind_max_kmh     != null ? +r.wind_max_kmh     : 0,
          wCode: r.weather_code     != null ? +r.weather_code     : 0,
        };
      });

    // 5. ECMWF forecast (non-fatal enrichment)
    const tForecast = Date.now();
    const forecast  = await fetchForecast(loc, startDate, endDate, process.env.OPEN_METEO_API_KEY);
    const forecastMs = Date.now() - tForecast;

    // 6. Assemble response with compute metrics
    const serverMs            = Date.now() - t0;
    const approxResponseBytes = JSON.stringify(records).length;

    console.log(`[analyze] Returning ${records.length} filtered records (${startMonth}/${startDay}–${endMonth}/${endDay}, ${location}) in ${serverMs}ms.`);

    return ok({
      records,
      locationName:  loc.name,
      fromCache:     cacheHit,
      totalCached:   count || rows.length,
      startYear:     START_YEAR,
      endYear:       END_YEAR,
      forecast:      forecast ?? null,
      metrics: {
        serverMs,
        cacheCheckMs,
        queryMs,
        forecastMs:          forecast ? forecastMs : null,
        rowsFetched:         rows.length,
        rowsFiltered:        records.length,
        approxResponseBytes,
        cacheHit,
        hasForecast:         !!forecast,
        forecastDays:        forecast ? forecast.length : 0,
      },
    }, origin);

  } catch (e) {
    console.error('[analyze] Error:', e);
    return err(500, e.message, origin);
  }
};
