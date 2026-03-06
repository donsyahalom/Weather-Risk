# WeatherRisk · Deployment Guide

A weather risk intelligence app powered by Joro (planette.ai) with Supabase auth and admin user management.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Pure HTML/CSS/JS (no build step) |
| Auth + DB | Supabase |
| Hosting | Netlify |
| CI/CD | GitHub Actions |

---

## Step 1 — Create Supabase Project

1. Go to [supabase.com](https://supabase.com) → New Project
2. Note your **Project URL** and **anon public key** (Settings → API)
3. Open **SQL Editor** → New Query → paste `supabase-setup.sql` → Run
4. Go to **Authentication → Settings → Email** → turn OFF "Enable email confirmations"

---

## Step 2 — Configure index.html

Open `index.html` and update these three lines near the top of the `<script>` block:

```js
const SUPABASE_URL  = 'https://xxxx.supabase.co';      // your project URL
const SUPABASE_ANON = 'eyJhbGciOi...';                  // your anon key
const ADMIN_EMAIL   = 'admin@yoursite.com';             // your admin email
```

> The anon key is safe to expose in client-side code — Supabase Row Level Security (RLS) policies protect your data.

---

## Step 3 — Create GitHub Repository

```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/YOUR_USERNAME/weatherrisk.git
git push -u origin main
```

---

## Step 4 — Deploy to Netlify

### Option A: Connect via Netlify UI (recommended)
1. [app.netlify.com](https://app.netlify.com) → Add new site → Import from Git
2. Choose your GitHub repo
3. Build command: *(leave blank)*  
   Publish directory: `.`
4. Deploy

### Option B: GitHub Actions auto-deploy
1. Create a Netlify site manually first (any blank deploy)
2. Add GitHub repo secrets:
   - `NETLIFY_AUTH_TOKEN` — Netlify → User Settings → Applications → New token
   - `NETLIFY_SITE_ID` — Netlify → Site Settings → General → Site ID
3. Push to `main` — GitHub Actions handles the rest

---

## Step 5 — First Login

Default admin credentials (set in `supabase-setup.sql`):
- Email: `admin@yoursite.com`
- Password: `ChangeMe123!`

**Change the password immediately after first login** via the Change Password tab.

---

## Admin Features

- **Dashboard** — live count of all accounts + full account table
- **Manage Accounts** — view all users, reset passwords, delete accounts
- **Create Account** — add new users or admins (active immediately)
- **Change Password** — change own password or send reset email to any user

## User Features

- Weather risk analysis via Joro ensemble (planette.ai API)
- 90% temperature confidence intervals (P5–P95)
- Inclement weather probability (precipitation, storm, wind)
- Joint risk scoring
- Demo mode when no API key is provided

---

## File Structure

```
/
├── index.html           # Full app (single file)
├── netlify.toml         # Netlify config + headers
├── supabase-setup.sql   # Run once to set up DB
├── README.md            # This file
└── .github/
    └── workflows/
        └── deploy.yml   # Auto-deploy on push to main
```
