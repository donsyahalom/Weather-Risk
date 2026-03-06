-- ================================================================
--  WeatherRisk · Supabase Setup
--  Run this ONCE in: Supabase Dashboard → SQL Editor → New Query
-- ================================================================

-- ── 1. PROFILES TABLE ─────────────────────────────────────────
create table if not exists public.profiles (
  id         uuid        references auth.users(id) on delete cascade primary key,
  email      text        not null,
  role       text        not null default 'user' check (role in ('admin','user')),
  created_at timestamptz not null default now()
);

-- ── 2. AUTO-CREATE PROFILE ON NEW SIGNUP ──────────────────────
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'user')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ── 3. ROW-LEVEL SECURITY ──────────────────────────────────────
alter table public.profiles enable row level security;

-- Users can read their own profile
drop policy if exists "users_read_own"    on public.profiles;
create policy "users_read_own" on public.profiles for select
  using (auth.uid() = id);

-- Admins can read ALL profiles
drop policy if exists "admins_read_all"   on public.profiles;
create policy "admins_read_all" on public.profiles for select
  using (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

-- Admins can insert profiles (for createAccount)
drop policy if exists "admins_insert"     on public.profiles;
create policy "admins_insert" on public.profiles for insert
  with check (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

-- Admins can update any profile (change role)
drop policy if exists "admins_update_all" on public.profiles;
create policy "admins_update_all" on public.profiles for update
  using (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

-- Admins can delete profiles
drop policy if exists "admins_delete_all" on public.profiles;
create policy "admins_delete_all" on public.profiles for delete
  using (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

-- ── 4. SEED ADMIN ACCOUNT ─────────────────────────────────────
--  Creates admin@yoursite.com / ChangeMe123!
--  Change the email and password before running!
do $$
declare
  admin_id uuid;
begin
  select id into admin_id from auth.users where email = 'admin@yoursite.com';

  if admin_id is null then
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at,
      confirmation_token, email_change, email_change_token_new, recovery_token
    ) values (
      '00000000-0000-0000-0000-000000000000',
      gen_random_uuid(),
      'authenticated', 'authenticated',
      'admin@yoursite.com',
      crypt('ChangeMe123!', gen_salt('bf')),
      now(),
      '{"provider":"email","providers":["email"]}', '{}',
      now(), now(),
      '', '', '', ''
    ) returning id into admin_id;
  end if;

  -- Ensure profile row is admin
  insert into public.profiles (id, email, role)
  values (admin_id, 'admin@yoursite.com', 'admin')
  on conflict (id) do update set role = 'admin';

  raise notice 'Admin seeded: id=%', admin_id;
end $$;

-- ── 5. DISABLE EMAIL CONFIRMATION ────────────────────────────
--  Do this in Dashboard → Authentication → Settings → Email
--  Toggle OFF "Enable email confirmations"
--  This lets newly created accounts log in immediately.

-- ================================================================
--  Setup complete. Next steps:
--  1. Copy your Project URL + anon key from Supabase Dashboard
--  2. Paste into index.html: SUPABASE_URL and SUPABASE_ANON
--  3. Update ADMIN_EMAIL in index.html to match admin@yoursite.com
--  4. Deploy to Netlify
-- ================================================================
