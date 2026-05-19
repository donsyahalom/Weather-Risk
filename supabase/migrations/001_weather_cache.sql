-- ============================================================
--  WeatherMyTrip — Initial Database Schema
--  Run this in: Supabase Dashboard → SQL Editor
--  Or: supabase db push (if using Supabase CLI)
-- ============================================================

-- ── weather_observations ─────────────────────────────────
-- Caches raw daily weather data fetched from Open-Meteo.
-- Keyed by (location_key, obs_date) so upserts are idempotent.
-- The Netlify function populates this on first request per location;
-- all subsequent requests read directly from here.

CREATE TABLE IF NOT EXISTS weather_observations (
  id               BIGSERIAL       PRIMARY KEY,
  location_key     TEXT            NOT NULL,          -- 'orlando' | 'miami'
  obs_date         DATE            NOT NULL,          -- calendar date of observation
  temp_max_c       NUMERIC(5, 2),                     -- daily max temperature (°C)
  temp_min_c       NUMERIC(5, 2),                     -- daily min temperature (°C)
  temp_mean_c      NUMERIC(5, 2),                     -- daily mean temperature (°C)
  precipitation_mm NUMERIC(7, 2),                     -- total precipitation (mm)
  wind_max_kmh     NUMERIC(6, 2),                     -- max wind speed (km/h)
  weather_code     SMALLINT,                          -- WMO weather interpretation code
  fetched_at       TIMESTAMPTZ     DEFAULT NOW(),     -- when this row was written

  CONSTRAINT uq_location_date UNIQUE (location_key, obs_date)
);

COMMENT ON TABLE  weather_observations IS 'Daily weather observations cached from Open-Meteo archive API.';
COMMENT ON COLUMN weather_observations.location_key IS 'Short identifier matching LOCATIONS config in the Netlify function.';
COMMENT ON COLUMN weather_observations.weather_code IS 'WMO Weather interpretation codes — 95/96/99 indicate thunderstorms.';

-- ── Indexes ───────────────────────────────────────────────

-- Primary lookup: all records for a location, ordered by date
CREATE INDEX IF NOT EXISTS idx_wo_location_date
  ON weather_observations (location_key, obs_date);

-- Covering index for the calendar-range filter (month + day extraction)
-- Postgres can use this to avoid full table scans on per-day queries
CREATE INDEX IF NOT EXISTS idx_wo_location_month_day
  ON weather_observations (location_key, EXTRACT(MONTH FROM obs_date), EXTRACT(DAY FROM obs_date));

-- ── Row Level Security ────────────────────────────────────
-- Writes go through the Netlify function using the SERVICE_ROLE key
-- (bypasses RLS). Reads are allowed publicly so the anon key can
-- also query if needed in future client-side features.

ALTER TABLE weather_observations ENABLE ROW LEVEL SECURITY;

-- Public read access (anon + authenticated)
CREATE POLICY "weather_observations_select"
  ON weather_observations
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Only the service role can insert/update (server-side only)
-- No explicit INSERT/UPDATE policy → service_role bypasses RLS automatically.

-- ── Supported Locations reference table ───────────────────
-- Keeps the frontend location list in sync with what's cached.

CREATE TABLE IF NOT EXISTS locations (
  key          TEXT  PRIMARY KEY,                     -- matches LOCATIONS config
  display_name TEXT  NOT NULL,
  latitude     NUMERIC(8, 4) NOT NULL,
  longitude    NUMERIC(8, 4) NOT NULL,
  timezone     TEXT  NOT NULL,
  active       BOOLEAN DEFAULT TRUE
);

INSERT INTO locations (key, display_name, latitude, longitude, timezone) VALUES
  ('orlando', 'Orlando, FL',  28.5383, -81.3792, 'America/New_York'),
  ('miami',   'Miami, FL',    25.7617, -80.1918, 'America/New_York')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "locations_select" ON locations FOR SELECT TO anon, authenticated USING (true);

-- ── Helpful view for debugging cache completeness ─────────

CREATE OR REPLACE VIEW cache_summary AS
SELECT
  location_key,
  COUNT(*)                                        AS total_days_cached,
  MIN(obs_date)                                   AS earliest_date,
  MAX(obs_date)                                   AS latest_date,
  COUNT(*) FILTER (WHERE weather_code IN (95,96,99)) AS storm_days,
  ROUND(AVG(temp_mean_c)::NUMERIC, 2)             AS avg_temp_c,
  MAX(fetched_at)                                 AS last_fetched_at
FROM weather_observations
GROUP BY location_key
ORDER BY location_key;

COMMENT ON VIEW cache_summary IS 'Quick overview of how much data is cached per location.';
