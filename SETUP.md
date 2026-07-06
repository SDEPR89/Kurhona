# Setup guide — Kurhona

This is a Vite + React + TypeScript app with Supabase auth (email/password + Google + GitHub OAuth), an Eisenhower-matrix task dashboard, calendar view, password reset, and theme toggle.

## 1. Create the Supabase project

1. Go to https://supabase.com/dashboard and sign in.
2. Click **New project**.
3. Pick an organization, name it (e.g. `kurhona`), set a strong database password (save it somewhere safe — you won't need it for this app, but you'll need it later if you query the DB directly), choose the closest region, and click **Create new project**. Wait ~1 minute for it to provision.

## 2. Grab your project credentials

In your project dashboard:

1. Go to **Project Settings → API** (the gear icon in the left sidebar).
2. Under **Project API keys**, copy:
   - **Project URL** — looks like `https://abcdefgh.supabase.co`
   - **anon public** key — a long `eyJ...` JWT string. (Never copy the `service_role` key — it bypasses Row Level Security.)

## 3. Fill in the `.env` file

In `~/Documents/Kurhona`:

```bash
# .env is gitignored; create it yourself in this directory if it doesn't already exist.
touch .env
```

Open `.env` and paste your values:

```
VITE_SUPABASE_URL=https://abcdefgh.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
```

Save the file. Vite reads `.env` on dev-server start, so you'll start the dev server in step 6 after editing this.

## 4. Enable Email/Password auth

In Supabase dashboard:

1. Go to **Authentication → Providers** (left sidebar).
2. Make sure **Email** is enabled (it is by default).
3. Optional but recommended: turn **Confirm email** ON — users will receive a confirmation email before they can sign in. For local testing you can turn it OFF to skip the email step.
4. If you turned confirm-email ON, you'll need to configure SMTP later (**Authentication → Email Templates → SMTP Settings**) — Supabase has a built-in dev mode that works for low-volume testing.

## 5. Configure OAuth providers (Google + GitHub)

### Google

1. Go to **Authentication → Providers → Google** and toggle it on.
2. You need a Google OAuth client. Two options:
   - **Quickest (using Supabase's built-in credentials)**: leave the Client ID / Secret fields alone — Supabase provides shared ones for development. Just toggle the provider on. Note: this only works on localhost.
   - **Recommended for real use**: create your own at https://console.cloud.google.com/apis/credentials → OAuth client ID → Web application. Add these Authorized redirect URIs:
     ```
     https://<your-project-ref>.supabase.co/auth/v1/callback
     ```
     Copy the Client ID and Secret into the Supabase Google provider config.

### GitHub

1. Go to **Authentication → Providers → GitHub** and toggle it on.
2. Create an OAuth app at https://github.com/settings/developers → **New OAuth App**.
   - Homepage URL: `http://localhost:5173` (for local dev)
   - Authorization callback URL:
     ```
     https://<your-project-ref>.supabase.co/auth/v1/callback
     ```
3. Copy the Client ID and generate a Client Secret, paste both into the Supabase GitHub provider config.

### Set the redirect URL

Go to **Authentication → URL Configuration**:

- **Site URL**: `http://localhost:5173` (change to your real domain later)
- **Additional redirect URLs**: add `http://localhost:5173` and your production URL.

This controls where Supabase redirects users after they confirm an email or finish an OAuth flow.

## 6. Run the app

```bash
cd ~/Documents/Kurhona
npm run dev
```

Open http://localhost:5173.

## 7. Test the flows

- **Sign up** with any email + 8+ char password. If confirm-email is ON, check the inbox (in dev mode check the Supabase **Authentication → Users** table for the user record; the confirmation email is captured by Supabase's inbucket in local dev — see note below).
- **Sign in** with the same credentials.
- **OAuth**: click "Continue with Google" / "Continue with GitHub" — you'll be bounced to the provider, then back to your app on success.
- **Password reset**: use the "Forgot password" link on the sign-in page; check your inbox (or inbucket) for the reset email.
- **Theme toggle**: switch between light and dark mode from the dashboard header.

### Local-only email testing

If you want to inspect outbound emails from Supabase locally (instead of configuring SMTP), run the Supabase CLI with `supabase auth` — it starts an inbucket SMTP catcher on port 54324. Not required for this app, just useful for debugging sign-up and password-reset emails.

## 8. Database setup (homework tracker)

The dashboard stores tasks and subjects in two Postgres tables. Run the schema once after the app is wired up.

1. In Supabase dashboard, open **SQL Editor** (left sidebar).
2. Click **New query**.
3. Open `~/Documents/Kurhona/supabase/schema.sql` in your editor, copy its entire contents, paste into the SQL editor.
4. Click **Run** (or press Cmd/Ctrl + Enter).
5. You should see "Success. No rows returned". Tables `tasks` and `subjects` now exist.
6. Verify in **Table Editor** (left sidebar):
   - Both tables visible.
   - Click `tasks` → look for the **shield icon** in the toolbar — that confirms RLS is enabled.
   - Same for `subjects`.

The schema also adds both tables to the `supabase_realtime` publication so the UI updates live when rows change (e.g. across browser tabs or when you edit from the Supabase dashboard).

The schema also defines a `public.delete_own_account()` RPC used by **Settings → Delete account**. It's `SECURITY DEFINER` and only granted to the `authenticated` role, so it can only be called by a signed-in user deleting themselves.

If you ever need to reset: you can drop both tables with
```sql
drop table if exists tasks cascade;
drop table if exists subjects cascade;
```
then re-run `schema.sql`.

## 8.5. Reminders (push notifications)

Optional. Skip this section if you don't need due-date push notifications —
the rest of the app works without it.

Reminders fire **3 days, 1 day, and (only when a due time is set) 1 hour**
before a task is due. They use Web Push, which works on every desktop
browser and on iOS Safari only when the user installs the PWA via **Share →
Add to Home Screen**. See `src/components/InstallPrompt.tsx` for the
in-app hint that surfaces on iOS.

### 1. Generate VAPID keys

A one-time step. The VAPID key pair signs every push so the push service
knows the message is from your app.

```bash
npx web-push generate-vapid-keys
```

You'll get back something like:

```
Public Key:  BNc...xyz
Private Key: abC...uvW
```

### 2. Store the secrets

**Supabase project secrets** (Settings → Edge Functions → Secrets, or `npx
supabase secrets set`):

- `VAPID_PUBLIC_KEY` — the public key from step 1
- `VAPID_PRIVATE_KEY` — the private key from step 1
- `VAPID_SUBJECT` — either `mailto:you@yourdomain.com` or `https://yourdomain.com`. The Edge Function prepends `mailto:` if you give a bare email.
- `SHARED_CRON_SECRET` — generate with `openssl rand -hex 32`. The cron job and Edge Function both check this.

**Frontend env vars** (in `.env` for local, in Vercel env for production):

- `VITE_VAPID_PUBLIC_KEY` — same public key as above. The browser needs it to subscribe.

### 3. Set the database GUCs

The cron body reads the function URL and shared secret from Postgres
custom settings so neither is hardcoded in `schema.sql`. Run once as a
superuser (Supabase SQL Editor with the `postgres` role):

```sql
ALTER DATABASE postgres SET app.send_push_url =
  'https://<your-project-ref>.supabase.co/functions/v1/send-push';
ALTER DATABASE postgres SET app.send_push_key = '<SHARED_CRON_SECRET>';
```

### 4. Enable the pg_cron and pg_net extensions

In the Supabase dashboard: **Database → Extensions** → enable both. They
need to be on for the cron schedule and HTTP call to work.

### 5. Run the schema

The new SQL is appended to `supabase/schema.sql` (the two new tables,
the RLS policies, the pg_cron schedule, and the `pg_net` HTTP call). Run
the whole file in the SQL Editor. The `create extension` lines and the
`cron.unschedule`/`cron.schedule` block are no-ops on a re-run.

### 6. Deploy the Edge Function

```bash
npx supabase functions deploy send-push --no-verify-jwt
```

The `--no-verify-jwt` flag disables Supabase's built-in JWT check
because the function does its own bearer-token check against
`SHARED_CRON_SECRET`. Make sure the secret is set (step 2) before
deploying, or every invocation will return 500.

### 7. Test it locally

The pg_cron job only runs in the production database (Supabase doesn't
expose it on local Docker). To exercise the Edge Function from your
machine, POST directly:

```bash
curl -X POST \
  -H "Authorization: Bearer $SHARED_CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{}' \
  https://<your-project-ref>.supabase.co/functions/v1/send-push
```

It should return `200 ok sent=0 dead=0` (no queued reminders yet). To
simulate one, insert a row directly into `notification_log` and re-run
the curl.

### 8. Drop in real PWA icons (before launch)

`public/manifest.json` currently points at `public/logo.png` and
`public/favicon.png` as placeholder icons. Before shipping, add real
sized icons at `public/icon-192.png` and `public/icon-512.png` and
update the manifest to reference them. iOS will also use
`apple-touch-icon` (currently `logo.png`).

## 9. Going to production

Before deploying:

1. In **URL Configuration**, replace `http://localhost:5173` with your real site URL, and add it to **Additional redirect URLs**.
2. Configure your own OAuth credentials (don't rely on Supabase's shared Google credentials outside localhost).
3. Configure SMTP for transactional email (Authentication → Email Templates → SMTP Settings).
4. Enable Row Level Security on any tables you add to the database — see https://supabase.com/docs/guides/auth/row-level-security.
5. The project is already wired for Vercel — `vercel.json` is in place. Push to a connected Git remote, or run `vercel` from the project root to deploy. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in the Vercel project settings (Environment Variables) for each environment.

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| `Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY` on dev-server start | `.env` is missing or empty; restart `npm run dev` after editing it |
| OAuth redirect fails with `redirect_uri_mismatch` | Add the callback URL to your provider's allowlist AND to Supabase's URL Configuration |
| Sign-up succeeds but sign-in says "Invalid login credentials" | Email confirmation is on and the user hasn't confirmed; check email or disable confirm-email in dev |
| `Auth session missing!` | Normal — it means no one is signed in. Only a bug if it appears when a user IS signed in. |
| Dashboard says "Loading…" forever | `tasks` and `subjects` tables don't exist yet — run `supabase/schema.sql` (section 8) |
| Tasks created in one tab don't show in another | Realtime isn't enabled — re-run `schema.sql`; the last lines add both tables to the `supabase_realtime` publication |
| RLS warning in Supabase logs | The policies in `schema.sql` already cover all roles; if you edited the schema, make sure you didn't drop the policies |
| Drag-and-drop does nothing on a task | Make sure you're using a desktop browser — dnd-kit pointer sensors need a real pointer; touch-only devices may not trigger |
| Password reset email never arrives | SMTP isn't configured; check the Supabase inbucket (port 54324) in dev, or configure SMTP for production |

## File map

```
~/Documents/Kurhona/
├── .env                          # your Supabase URL + anon key
├── .env.example                  # template
├── vercel.json                   # Vercel deployment config
├── supabase/
│   └── schema.sql                # tasks + subjects tables, RLS, triggers
├── src/
│   ├── App.tsx                   # auth state + LoginPage/Dashboard/ResetPassword switch
│   ├── App.css                   # login styles
│   ├── index.css                 # design tokens + base layout
│   ├── main.tsx                  # entry
│   ├── types.ts                  # shared types + quadrant metadata
│   ├── lib/
│   │   ├── supabase.ts           # Supabase client (reads VITE_* env vars)
│   │   ├── dragIds.ts            # dnd-kit id helpers
│   │   ├── reorder.ts            # array reorder utilities
│   │   └── taskSort.ts           # manual + due-date sort logic
│   ├── hooks/
│   │   ├── useSubjects.ts        # list + add subjects (with realtime)
│   │   ├── useTasks.ts           # CRUD tasks (with realtime)
│   │   ├── useDragAndDrop.ts     # dnd-kit wiring
│   │   ├── useMediaQuery.ts      # responsive helpers
│   │   ├── useTheme.ts           # light/dark mode
│   │   ├── useToast.tsx          # toast notifications
│   │   └── useConfirm.tsx        # confirm-dialog state
│   └── components/
│       ├── LoginPage.tsx
│       ├── ResetPassword.tsx     # password reset flow
│       ├── ConfirmingPage.tsx    # email-confirmation landing
│       ├── Dashboard.tsx         # 4-quadrant grid + Active/Done toggle
│       ├── Calendar.tsx          # calendar view of tasks
│       ├── DoneList.tsx          # done-tasks view
│       ├── Quadrant.tsx
│       ├── TaskCard.tsx
│       ├── TaskModal.tsx         # create/edit form
│       ├── SubjectSelect.tsx     # subject picker in task modal
│       ├── SubjectManager.tsx    # inline add-subject popover
│       ├── SettingsModal.tsx     # settings dialog
│       ├── ThemeToggle.tsx       # light/dark switch
│       ├── ConfirmDialog.tsx     # generic confirm modal
│       ├── ToastViewport.tsx     # toast container
│       └── settings/             # sections inside SettingsModal
│           ├── shared.tsx
│           ├── UsernameSection.tsx
│           ├── PasswordSection.tsx
│           ├── DeleteAccountSection.tsx
│           ├── UpgradeAccountSection.tsx
│           └── SessionSection.tsx
└── SETUP.md                      # this file
```
