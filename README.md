# Fuego Steakhouse & Bar — website + CRM on one Cloudflare Worker

Live site: https://www.fuegosteaks.com (the apex `fuegosteaks.com` 301-redirects to www).
CRM portal: https://www.fuegosteaks.com/admin/
Repo: `Smart-Marketingg/fuego-steakhouse` (private). Workflow `dev` → PR → `main`.

## 1. What this is

A single Cloudflare Worker (`fuego-steakhouse`) serves the static marketing site from the repo root through the Workers assets binding and, under `/api/*`, runs the CRM API in `src/`. Website forms (reservation request, private event inquiry, contact message, newsletter signup) post to `POST /api/lead`; the Worker validates and stores the lead in D1, puts any attachment in the private R2 bucket, emails a branded notification to the restaurant through Resend, optionally sends an auto-reply to the guest, and redirects the visitor to `/thank-you`. D1 is the single source of truth for leads; there is no Google Sheet, Apps Script or third-party form backend any more.

The portal at `/admin/` is a static, dependency-free app (`admin/`) that talks only to `/api/*`. Staff sign in with email and password (or optional Google sign-in for existing accounts), work leads through one five-stage pipeline per form, add notes, export CSV, and, depending on role, manage the team, integration keys, auto-reply templates, the weekly AI summary, the media library and the audit log. Everything business-specific (names, addresses, sender, colors, time zone, form definitions) comes from `wrangler.jsonc` vars and `src/forms.config.js`, so the same code can be provisioned for another business by changing configuration only (see `docs/runbook.md`).

```
                 visitor / staff browser
                          |
                          v
            Cloudflare edge (DNS, TLS, WAF rate limit, Turnstile widget)
                          |
                          v
          +-----------------------------------------+
          |  Worker: fuego-steakhouse  (src/worker.js) |
          |  run_worker_first: headers, redirects      |
          |                                            |
          |   /api/*  --> router --> auth / leads /    |
          |              team / settings / media /     |
          |              analytics / automation / audit|
          |   /*      --> ASSETS binding (repo root,   |
          |              minus .assetsignore)          |
          |   cron */15 * * * * --> retries, weekly summary    |
          +----+--------+--------+--------+-----------+
               |        |        |        |
      D1 "DB"  |  R2 MEDIA  R2 PRIVATE   outbound fetch
   fuego-      |  fuego-    fuego-        |-- Resend (email)
   steakhouse  |  media     private       |-- Turnstile siteverify
   (leads,     |  (public,  (lead         |-- GA4 Data API (service-account JWT)
   users,      |  media.    attachments,  |-- Anthropic Messages API (weekly summary)
   settings,   |  fuego-    served only   |-- Google OAuth (optional sign-in)
   audit...)   |  steaks.   via /api/     |
               |  com)      leads/:id/file)

   GitHub Smart-Marketingg/fuego-steakhouse
      main   ---- Workers Builds ---- npx wrangler deploy            -> fuego-steakhouse (prod, www.fuegosteaks.com)
      dev/*  ---- Workers Builds ---- npx wrangler versions upload   -> preview version URL of fuego-steakhouse (not deployed)
      local  ---- npm run deploy:preview -----------------------------> fuego-steakhouse-preview (workers.dev, own D1 + R2)
```

## 2. Repo layout

The repo root is the site. Anything listed in `.assetsignore` is not uploaded as a public asset.

| Path | What it is |
|---|---|
| `*.html`, `styles*.css`, `app*.js`, `calendar*.js`, `flames*.js`, `image-slot*.js`, `assets/`, `robots.txt`, `sitemap.xml`, `_redirects`, `llms.txt`, `404.html` | The live website, served as static assets with clean URLs (`/menus` for `menus.html`). |
| `lead.js` | Site-side form helper: posts forms to `/api/lead` (url-encoded, `X-Requested-With: crm-site`), adds the honeypot, captures UTM/landing/referrer once per session, forwards the Turnstile token, redirects old `#/` links. Loaded on every page before `app.js`. |
| `thank-you.js` / `thank-you.html` | Per-form confirmation copy (reads `sessionStorage['fn-thanks']` set by `lead.js`, then `?type=`). |
| `src/worker.js` | Entry point: apex→www redirect, legacy path redirects, `/api/*` dispatch, assets fallthrough, security headers, cron handler. |
| `src/router.js` | Tiny method + `:param` router with middleware chain. |
| `src/util.js` | ids, hashing, IP hashing, JSON/redirect responses, input cleaning, CSV escaping, time-zone date ranges, body parsing. |
| `src/forms.config.js` | The one place that defines the four forms, their fields, auto-reply defaults and the pipeline stage labels. Overridable at deploy time with the `FORMS_JSON` var. |
| `src/auth.js` | Roles, permissions, sections, `can(user, permission)`, PBKDF2 passwords, sessions, CSRF/origin check, login rate limit, set/invite/reset tokens, Google sign-in. |
| `src/leads.js` | `POST /api/lead` capture (origin, honeypot, rate limit, Turnstile, validation, upload by magic bytes, notification + auto-reply in `waitUntil`), lead list/detail/stage/notes/delete/CSV/attachment, dashboard. |
| `src/email.js` | Resend transport (never throws; logs to `email_log`), branded table-based templates: notification, auto-reply, invite, reset, weekly summary; email health. |
| `src/settings-crypto.js` | AES-GCM encryption of portal keys with `SETTINGS_KEY`, `resolveSecret` (Cloudflare secret wins over portal value), integration status, GA4 property id, small D1 cache. |
| `src/settings.js` | Settings API: business info (read-only, from vars), notification emails/routes, Turnstile site key (stored only; the site reads the key from the HTML, see §6), encrypted keys, connection tests. |
| `src/analytics.js` | GA4 Data API with a WebCrypto RS256 service-account JWT (no SDK), 15-minute cache in D1. |
| `src/automation.js` | Per-form auto-reply templates (preview, test send), weekly summary (Anthropic when a key exists, plain text otherwise), cron gate on `WEEKLY_SUMMARY_HOUR` in `TIMEZONE`. |
| `src/media.js` | Media library: image upload/replace/delete in the public `MEDIA` bucket, served from `MEDIA_URL`. |
| `src/team.js` | Team management: invite, update role/perms/hidden sections/active, reset link, force sign-out; protects the last active admin. |
| `src/headers.js` | Security headers for every response; strict CSP, `no-store`, `noindex` on `/admin` and `/api`. |
| `src/audit.js` | Audit log writer, list and CSV export. |
| `admin/` | The portal: `index.html`, `admin.js`, `admin.css`. No inline scripts (CSP). |
| `schema.sql` | Idempotent D1 schema (every table and column the code reads). |
| `schema.oneline.sql` | Same schema flattened to one line for the D1 console. Regenerate with `npm run schema:oneline`. |
| `migrations/` | Later schema changes as `NNNN-name.sql` (idempotent). Created when the first migration is needed. |
| `scripts/bootstrap-admin.mjs` | Prints the SQL + one-time `#set=` link that creates the first admin. |
| `scripts/flatten-schema.mjs` | Builds `schema.oneline.sql` from `schema.sql`. |
| `tests/` | `node --test` suite (`npm test`). |
| `docs/api.md` | The API contract. `docs/launch-playbook.md` (owner) and `docs/runbook.md` (new tenant) live here too. |
| `.assetsignore` | Files that must never be served publicly (worker code, schema, wrangler config, docs, tests, drafts). |
| `wrangler.jsonc` | Worker name, assets, routes, cron, vars, D1/R2 bindings for live and the `preview` environment. |
| `.dev.vars` (not committed) | Local secrets for `wrangler dev`. |

Non-live folders still in the repo and excluded by `.assetsignore`: `export/`, `site/`, `screenshots/`, `uploads/`, `_ds/`, plus `google-sheet-script.gs`, `SETUP-Google-Sheet.txt`, `github.md`, `Fuego Steakhouse (Canva).html`, `tweaks-*.jsx`. The owner should delete them from the repo; the site does not use them.

## 3. Configuration

### Vars (`wrangler.jsonc` → `vars`, repeated under `env.preview.vars`)

| Var | Meaning |
|---|---|
| `SITE_URL` | Canonical origin. Used for the apex→www redirect, CSRF/origin checks, links in emails, the Google OAuth redirect URI. Preview: the workers.dev URL. |
| `BUSINESS_NAME` | Shown in emails, the portal header and the weekly summary. |
| `BUSINESS_ADDRESS` | Email footer. |
| `BUSINESS_PHONE` | Email footer, `{phone_number}` placeholder in auto-replies. |
| `WORKER_NAME` | The Worker's name (`fuego-steakhouse`). The same-origin check on `/api/lead` accepts only `SITE_URL`, the request's own host and `<WORKER_NAME>[-env].<account>.workers.dev`, so other people's workers.dev sites cannot post leads. |
| `NOTIFY_EMAILS` | Default recipients of lead notifications (comma list; currently info@fuegosteaks.com and info@chdiner.com). Can be overridden in the portal Settings page. |
| `NOTIFY_ROUTES` | JSON `{ "<form id>": "a@x.com, b@x.com" }` per-form overrides (e.g. `event` → `events@fuegosteaks.com`). Portal routes merge on top. |
| `MAIL_FROM` | Resend sender, `Name <info@fuegosteaks.com>`. Must be on a domain verified in Resend. |
| `MAIL_REPLY_TO` | Reply-to for auto-replies and the weekly summary (notifications reply to the guest). |
| `TIMEZONE` | IANA zone for date filters, email timestamps and the weekly cron gate. `America/New_York`. |
| `GA4_PROPERTY_ID` | Numeric GA4 property id, or `none`. A value entered in portal Settings takes precedence. |
| `MEDIA_URL` | Public base URL of the `MEDIA` bucket (`https://media.fuegosteaks.com`). Also allowed in the admin CSP `img-src`. |
| `BRAND_COLOR`, `BRAND_BG`, `BRAND_INK` | Colors used by the email templates. |
| `LOGO_URL` | Logo in emails. |
| `WEEKLY_SUMMARY_HOUR` | Local hour (0–23) on Monday when the weekly summary goes out. `8`. |
| `FORMS_JSON` (optional, not set) | JSON of the same shape as `DEFAULT_FORMS`/`DEFAULT_PIPELINES` to replace the form definitions without code changes. Invalid JSON falls back to the built-ins and shows a dashboard warning. |
| `ANTHROPIC_MODEL` (optional, not set) | Overrides the model used for the weekly summary (default `claude-sonnet-5-5`). |

### Secrets (`npx wrangler secret put NAME`, and `--env preview`; never in the repo)

| Secret | Required | Where to get it | Without it |
|---|---|---|---|
| `SETTINGS_KEY` | Yes | `openssl rand -base64 32` | Every `/api/*` route except `/api/health` answers `503 not_configured`. Also salts IP hashes and encrypts portal keys. |
| `RESEND_API_KEY` | No | Resend → API Keys | No emails (notifications, auto-replies, invites, resets, weekly). Leads are still saved; dashboard shows "Resend is not connected"; invite/reset links are shown to the admin instead of emailed. |
| `TURNSTILE_SECRET` | No | Cloudflare → Turnstile → widget "Fuego website forms" → Secret key. Set on both Workers. | Forms rely on honeypot + rate limit only; dashboard warns "Turnstile is not enabled". |
| `GA_SERVICE_ACCOUNT` | No | Google Cloud → service account → JSON key (paste the whole file) | Analytics shows "Not connected"; weekly summary omits website stats. |
| `ANTHROPIC_API_KEY` | No | console.anthropic.com | Weekly summary is sent as a plain stats list instead of AI prose. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | No | Google Cloud → OAuth client (web); redirect URI `https://www.fuegosteaks.com/api/auth/google/callback` | "Sign in with Google" button is hidden; `/api/auth/google` returns 404. |

### Portal Settings vs Cloudflare secret

Every optional key above can instead be pasted in the portal at **Settings → Integrations** (admin only). Portal values are AES-GCM encrypted with `SETTINGS_KEY` before being written to the D1 `settings` table and are never returned to the browser in full (last 4 characters only). Resolution order in `src/settings-crypto.js` (`resolveSecret`): **a Cloudflare secret always wins; the portal value is used only when the secret is absent.** The Settings page shows the source as `secret`, `portal` or `none`. Entering an empty value removes a portal key. `GA4_PROPERTY_ID` works the other way around: a portal value overrides the var. The **Turnstile site key** field on the Settings page is stored but nothing reads it; the real site key is hard-coded in the HTML pages (§6).

## 4. One-time setup

Prerequisites: Node 20 or newer (`package.json` has `"engines": { "node": ">=20" }`; see §10 for why), `npx wrangler` 3.114 (installed by `npm install`), a Cloudflare account that owns `fuegosteaks.com`, `npx wrangler login`.

1. Install.
   ```bash
   npm install
   ```
2. Create the databases and paste the ids into `wrangler.jsonc`.
   ```bash
   npx wrangler d1 create fuego-steakhouse
   npx wrangler d1 create fuego-steakhouse-preview
   ```
   Put the live id in `d1_databases[0].database_id` and the preview id in **both** `d1_databases[0].preview_database_id` **and** `env.preview.d1_databases[0].database_id`. All three placeholders say `REPLACE_WITH_…`.
3. Create the four R2 buckets (ENAM location hint).
   ```bash
   npx wrangler r2 bucket create fuego-media --location enam
   npx wrangler r2 bucket create fuego-media-preview --location enam
   npx wrangler r2 bucket create fuego-private --location enam
   npx wrangler r2 bucket create fuego-private-preview --location enam
   ```
   Then in the dashboard: R2 → `fuego-media` → Settings → Custom Domains → Connect `media.fuegosteaks.com` (this enables public access through that hostname). Leave `fuego-private*` without public access.
4. Set secrets (live, then preview).
   ```bash
   openssl rand -base64 32          # copy the output
   npx wrangler secret put SETTINGS_KEY
   npx wrangler secret put SETTINGS_KEY --env preview
   # optional, repeat with --env preview as needed:
   npx wrangler secret put RESEND_API_KEY
   npx wrangler secret put TURNSTILE_SECRET
   npx wrangler secret put GA_SERVICE_ACCOUNT      # paste the full JSON file contents
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```
   Use a different `SETTINGS_KEY` for preview. Rotating it later makes existing portal-entered keys unreadable (see `docs/runbook.md`).
5. Run the schema. Three equivalent ways; the file is idempotent, so running it again is safe.
   ```bash
   npm run schema:local      # local wrangler dev database
   npm run schema:live       # = npx wrangler d1 execute fuego-steakhouse --remote --file=schema.sql
   npm run schema:preview    # = npx wrangler d1 execute fuego-steakhouse-preview --remote --file=schema.sql
   ```
   D1 console alternative: Dashboard → D1 → database → Console. **The console accepts a single line only.** Open `schema.oneline.sql`, copy its one line, paste, Execute. Do this for both databases. If you edit `schema.sql`, run `npm run schema:oneline` to regenerate the one-line file.
6. Deploy once so the Worker exists (or let Workers Builds do it in step 8).
   ```bash
   npx wrangler deploy
   npx wrangler deploy --env preview
   ```
7. Bootstrap the first admin.
   ```bash
   node scripts/bootstrap-admin.mjs jullien@smartmarketingg.com "Jullien"
   ```
   The script prints (a) one line of SQL and (b) a link. Run the SQL against the live database, either in the D1 console or with
   ```bash
   npx wrangler d1 execute fuego-steakhouse --remote --command "<printed SQL>"
   ```
   then open `https://www.fuegosteaks.com/admin/#set=<token>` **within 24 hours** and set a password (10+ characters). The token is single use. For the preview portal, run the script again, execute the SQL against `fuego-steakhouse-preview`, and open the same `#set=` fragment on the preview URL instead (the script always prints the www host).
8. Connect GitHub to Workers Builds: Dashboard → Workers & Pages → Create → **Import a repository** → `Smart-Marketingg/fuego-steakhouse`.
   - Worker name: `fuego-steakhouse`
   - Production branch: `main`
   - Root directory: `/`
   - Build command: *(empty)*
   - Deploy command: `npx wrangler deploy`
   - Non-production branch deploy command ("Version command"): `npx wrangler versions upload`
   Every push to `main` deploys production. Every push to another branch uploads a *version* of `fuego-steakhouse` that is not deployed; its preview URL is posted on the PR. **Never put `npx wrangler deploy --env preview` here**, see §11. The separate preview Worker is deployed from a laptop with `npm run deploy:preview`.
9. Custom domains. The `routes` in `wrangler.jsonc` (`www.fuegosteaks.com` and `fuegosteaks.com`, both `custom_domain: true`) are created on deploy. Confirm under Worker → Settings → Domains & Routes; the zone must be on this account. **Cut-over from the old Cloudflare Pages project (do this before the first production deploy):** the zone currently has two CNAME records, `fuegosteaks.com` and `www.fuegosteaks.com`, pointing at `fuego-steakhouse.pages.dev`. While they exist, `wrangler deploy` cannot attach the custom domains and fails with a "hostname already in use" error. In **Workers & Pages → fuego-steakhouse (Pages) → Custom domains**, remove both domains (Cloudflare deletes the CNAMEs with them), confirm under DNS → Records that they are gone, then deploy. Expect a few minutes of downtime between removing the Pages domains and the Worker deploy finishing; do it off-hours and have the deploy ready to run.
10. Media domain: step 3 above (`media.fuegosteaks.com` on `fuego-media`). `MEDIA_URL` already points at it.
11. Smoke test: `curl -s https://www.fuegosteaks.com/api/health` → `{"ok":true,"db":true,"settings_key":true,...}`; submit each form; open `/admin/`.

## 5. Email (Resend)

1. In Resend → Domains → Add domain `fuegosteaks.com` (region of your choice).
2. Resend shows DNS records (SPF `TXT`, DKIM `TXT`/`CNAME`, optionally MX for the bounce subdomain). Add each one in Cloudflare → DNS for `fuegosteaks.com`, exactly as shown, proxy status **DNS only** (grey cloud).
3. Wait until the domain shows **Verified** in Resend.
4. `MAIL_FROM` must use that domain: `Fuego Steakhouse & Bar <info@fuegosteaks.com>` (already set). Replies go to `MAIL_REPLY_TO`.
5. Create an API key (Sending access) and either `npx wrangler secret put RESEND_API_KEY` or paste it in portal **Settings → Integrations → Resend**.
6. Click **Test connection** in Settings: it lists your Resend domains and reports whether `fuegosteaks.com` is verified. Then use **Automations → Send test** to receive a real auto-reply.

Every send is logged in `email_log`; the Dashboard shows sent/failed counts for the last 7 days and the last error. A failed email never loses a lead (`leads.email_status = failed`, with the error text).

## 6. Spam protection on `/api/lead`

Four layers, in request order:

1. **Origin check** — `Origin`/`Referer` must match the request host, `SITE_URL`, `*.workers.dev`, or localhost.
2. **Honeypot** — `lead.js` injects a hidden `website` field; if it is filled the API answers success and stores nothing.
3. **Per-IP limit in D1** — 5 submissions per 10 minutes per hashed IP (`auth_attempts`, scope `lead_ip`) → `429 rate_limited`.
4. **Turnstile** (when a secret exists) — token verified against `challenges.cloudflare.com/turnstile/v0/siteverify`; missing/invalid → `400 turnstile`.

Turnstile is enabled (since PR #59, 2026-10-21). Current state:

- Widget: Cloudflare → Turnstile → **Fuego website forms** (Managed mode). Hostnames: `fuegosteaks.com` (covers `www`) and the preview host `fuego-steakhouse-preview.smart-marketing732.workers.dev`.
- Site key `0x4AAAAAAFfm-OYEtcwxW6P4` is hard-coded in the five pages with forms: `index.html`, `menus.html`, `gift-cards.html`, `large-events.html`, `contact.html`. Each has the `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer>` tag in the head and a `<div class="cf-turnstile" data-sitekey="…">` inside the form. `lead.js` forwards `cf-turnstile-response` automatically.
- `TURNSTILE_SECRET` is set as a Cloudflare secret on **both** Workers (`fuego-steakhouse` and `fuego-steakhouse-preview`). `/api/health` reports `turnstile:true` on each.
- The portal field **Settings → Turnstile site key** (`turnstile_site_key`) is stored but not read by anything; leave it blank.

To rotate the key: create a new widget (or rotate the secret), replace the `data-sitekey` value in the five pages, deploy, then `npx wrangler secret put TURNSTILE_SECRET` on both Workers (`--env preview` for the second). Change the HTML first: a secret with no matching widget in the page fails every submission with the "complete the verification" message. To disable: delete the secret from both Workers (the API then skips the check) and remove the script tag and divs.

Cloudflare WAF rate-limiting rule (edge, before the Worker):

1. Dashboard → zone `fuegosteaks.com` → Security → WAF → **Rate limiting rules** → Create rule.
2. Name: `lead form flood`.
3. If incoming requests match — Edit expression:
   ```
   (http.request.uri.path eq "/api/lead" and http.request.method eq "POST")
   ```
4. Characteristics: IP. Requests: `10`. Period: `1 minute`.
5. Action: **Block**. Duration (mitigation timeout): `1 hour`.
6. Deploy.

## 7. GA4 analytics (optional)

1. Google Cloud console → create a project. If the Workspace org policy blocks service-account key creation (`iam.disableServiceAccountKeyCreation`), create the project **without an organization** ("No organization") or use a personal Google account.
2. APIs & Services → Enable **Google Analytics Data API**.
3. IAM & Admin → Service Accounts → Create (`fuego-crm-analytics`). Keys → Add key → JSON. Download the file.
4. Google Analytics → Admin → **Property access management** → Add user → the service account email (`…@…iam.gserviceaccount.com`) with role **Viewer**.
5. Find the numeric **property ID**: GA Admin → Property settings → Property details (a number such as `123456789`). The site's measurement ID `G-9W4G1DC2TT` is not it.
6. Paste the whole JSON file as the `GA_SERVICE_ACCOUNT` secret (or in Settings → GA4 service account) and set the property id in Settings → GA4 property ID (or change the `GA4_PROPERTY_ID` var from `none`).
7. Settings → **Test connection** reports sessions for the last 7 days. The Analytics section shows sessions, users, pageviews, conversions, daily series, top pages, channels, lead-tracking events (`generate_lead`, `form_submit`, `lead`) and leads by UTM source from D1. Reports are cached in the D1 `cache` table for 15 minutes; the access token is cached for its lifetime.

## 8. Weekly AI summary (optional)

- Cron in `wrangler.jsonc`: `*/15 * * * *` (every 15 minutes; it also retries lead notifications stuck in `pending` and prunes expired sessions). `scheduledWeekly` only runs on Mondays when the local hour in `TIMEZONE` equals `WEEKLY_SUMMARY_HOUR` (`8`), so exactly one of the two firings matches 8:00 in New York across EDT/EST, and `last_week_key` prevents a second send in the same week.
- Content: new leads in the last 7 days, still-waiting count, per-form new/won, emails sent/failed, GA4 sessions/users/top channels when connected, plus a short prose summary generated with the Anthropic Messages API when `ANTHROPIC_API_KEY` (or the portal key) exists. **Without a key the same email goes out with the plain stats list.**
- Recipients: Automations → Weekly summary → recipients; empty means all active admins. Toggle on/off there. **Run now** sends immediately (forces, ignores the once-per-week gate) and shows last run / last error.
- The cron handler also prunes `auth_attempts`, expired sessions and used set tokens.

## 9. Team, roles and permissions

Defined once in `src/auth.js`:

- Roles: `admin` (every permission) and `staff` (`dashboard.view, leads.view, leads.edit, notes.add, analytics.view` plus any extra permissions granted per user in `users.perms`).
- Permissions: `dashboard.view, leads.view, leads.edit, leads.delete, leads.export, notes.add, analytics.view, automations.manage, media.manage, team.manage, settings.manage, audit.view`.
- Sections (sidebar): `dashboard, leads, analytics, automations, media, team, settings, audit`. Admins can hide any section per user (`users.off`); a hidden section's routes answer `403 section_off`, so it is enforced by the API, not just the menu.
- `can(user, permission)` is the single check; every route uses `requirePerm('<permission>')`.

Flows (Team section, `team.manage`):

- **Invite**: email, name, role, extra permissions, hidden sections → a 24-hour single-use `#set=` link is emailed (Resend) or, when Resend is not connected, shown to the admin to pass on. Reinviting an inactive or password-less user reuses the row. A user with an active password cannot be invited again (`409 exists`).
- **Reset password**: 15-minute single-use link, emailed or shown. Users can also use "Forgot password" on the sign-in page (always answers OK; rate limited per IP).
- Setting a password through any link signs the user out everywhere and signs them in on the current device.
- **Deactivate** removes all sessions. You cannot deactivate/demote yourself or the last active admin.
- **Sign out everywhere**: admins per user (Team → Sign out), or a user for themselves (`POST /api/auth/logout-all`).
- Sessions: 12 h, or 30 days with "Keep me signed in"; 30-minute idle timeout unless remembered; the portal pings every 5 minutes. Login lockout: 5 failures per 15 minutes per email and per IP.
- Google sign-in (when configured) only works for emails that already have an active user; it never creates accounts.

## 10. Local development

> Local state (D1, R2) is persisted to `../.wrangler-state-fuego-steakhouse`, **outside** the project, on purpose: the site root is the assets folder, and if Miniflare's state lived inside it every database write would restart `wrangler dev` and kill background work such as the lead notification email. Always use the npm scripts (or pass the same `--persist-to`) so `wrangler dev` and `d1 execute --local` see the same database. `npm run d1:local -- "<sql>"` runs a one-off local query.

Use **Node 20 or newer**. Wrangler/Miniflare lists the static asset folder with `fs.readdir(dir, { recursive: true })`, which Node 18 silently ignores, so with Node 18 every file in a subfolder (`assets/`, `admin/`) returns 404 in `wrangler dev` while the root pages still work. Install it with `nvm install 20 && nvm use 20` or `brew install node@20`. No-install fallback on a machine stuck on old Node:

```bash
npx -p node@20.19.0 -c "npx wrangler dev"
```

1. Create `.dev.vars` (git-ignored) with at least:
   ```
   SETTINGS_KEY=<output of openssl rand -base64 32>
   ```
   Add `RESEND_API_KEY=…` etc. only if you want real integrations locally.
2. Create the local schema and start the dev server.
   ```bash
   npm run schema:local
   npm run dev            # http://localhost:8787 (site + /admin/ + /api/)
   ```
   `npm run dev:remote` runs against the **preview** D1/R2 (`preview_database_id` / `preview_bucket_name`), never live.
3. Bootstrap a local admin.
   ```bash
   node scripts/bootstrap-admin.mjs you@example.com "You"
   npx wrangler d1 execute fuego-steakhouse --local --command "<printed SQL>"
   ```
   Open `http://localhost:8787/admin/#set=<token>`.
4. Tests.
   ```bash
   npm test               # node --test tests/
   ```

## 11. Dev → main workflow and preview isolation

- Work on `dev` (or a feature branch). Push. Workers Builds runs `npx wrangler versions upload`: the branch code is uploaded as a new, **undeployed** version of the production Worker and a preview URL (`<version>-fuego-steakhouse.smart-marketing732.workers.dev`) is posted on the PR. That version uses the production bindings (live D1 and R2), so treat it as a read-only look at the pages, not a place to submit test leads.
- For an isolated preview with its own data, deploy the preview Worker from a laptop: `npm run deploy:preview` (= `wrangler deploy --env preview`, Node 20). It has its own name `fuego-steakhouse-preview`, its own D1, `fuego-media-preview`/`fuego-private-preview` R2, its own secrets and its own `SITE_URL` (workers.dev). It cannot touch live data as long as the `env.preview` ids in `wrangler.jsonc` really are the preview resources.
- **Why Workers Builds must not run `npx wrangler deploy --env preview`.** Workers Builds always deploys to the Worker the repository is connected to and overrides the name from `wrangler.jsonc`. With `--env preview` it therefore uploads the branch code *with the preview bindings and vars* onto the production Worker `fuego-steakhouse`: live traffic on www.fuegosteaks.com gets the preview D1, preview R2 and preview `NOTIFY_EMAILS` until the next `main` build. This happened on 2026-10-21 (build `de8921e2`, branch `feature/turnstile`, 8 hours until the next main build; no leads were lost). Keep the non-production command at `npx wrangler versions upload`, or untick "Builds for non-production branches".
- Open a PR `dev` → `main`, test on the preview URL posted on the PR (or on the preview Worker), merge. `main` deploys production. `main` should be a protected branch.
- Pitfall: if `dev` and `main` show merge conflicts that nobody caused (typically after a squash merge or a force-push), do not "resolve" them. Reset `dev` to `main` and re-apply the pending work:
  ```bash
  git checkout dev
  git fetch origin
  git reset --hard origin/main
  git push --force-with-lease origin dev
  ```

## 12. Security summary

- Headers on every response (`src/headers.js`): HSTS (1 year, preload), `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Permissions-Policy` (camera, mic, geolocation, payment, usb off), `Referrer-Policy: strict-origin-when-cross-origin`.
- `/admin*` and `/api/*` additionally: `X-Robots-Tag: noindex, nofollow`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, CSP `default-src 'self'; script-src 'self'; style-src 'self' fonts.googleapis.com; font-src fonts.gstatic.com; img-src 'self' data: blob: MEDIA_URL; connect-src 'self'; frame-src challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`. The portal has no inline scripts.
- Session cookie `crm_session`: `HttpOnly; Secure; SameSite=Strict; Path=/`; only its SHA-256 hash is stored.
- Passwords: PBKDF2-SHA256, 100,000 iterations (Workers maximum), per-user 16-byte salt, constant-time compare, identical error and timing for unknown emails.
- CSRF: every non-GET `/api/*` request (except the public lead post) needs header `X-Requested-With` and an allowed `Origin`.
- IPs are stored only as a salted SHA-256 prefix (salt derived from `SETTINGS_KEY`).
- Portal-entered keys are AES-GCM encrypted with `SETTINGS_KEY`; only the last 4 characters ever return to the browser.
- One-time tokens (bootstrap/invite/reset) are stored hashed, single use, expiring (24 h / 24 h / 15 min).
- Uploads validated by magic bytes and extension, 10 MB cap, random key in the private bucket, downloadable only through `GET /api/leads/:id/file` with `leads.view`.
- CSV cells starting with `= + - @` are prefixed to defuse formula injection.
- `.assetsignore` keeps `src/`, `tests/`, `scripts/`, `migrations/`, `docs/`, `node_modules/`, `schema*.sql`, `wrangler.jsonc`, `package*.json`, `README.md`, `.git*`, `.dev.vars*`, `.wrangler/`, the non-live folders and drafts out of the public asset bundle.
- `robots.txt` disallows `/admin/`, `/api/`, `/thank-you`; `sitemap.xml` excludes them.

Verify after each deploy that nothing private is reachable (all must be `404`):

```bash
curl -I https://www.fuegosteaks.com/schema.sql
curl -I https://www.fuegosteaks.com/src/worker.js
curl -I https://www.fuegosteaks.com/wrangler.jsonc
curl -I https://www.fuegosteaks.com/docs/api.md
```

## 13. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Every API call answers `503 not_configured` | `SETTINGS_KEY` secret missing for that Worker/env. `npx wrangler secret put SETTINGS_KEY` (add `--env preview` for preview). Locally: `.dev.vars`. |
| Subfolders 404 in `wrangler dev` (`/assets/…`, `/admin/` missing; root pages fine) | Node older than 20. Miniflare's recursive `readdir` is ignored by Node 18. `nvm use 20` or `npx -p node@20.19.0 -c "npx wrangler dev"`. |
| `503 no_schema` | Schema never run on that database. Run `schema.sql` (step 5) on the right db (live vs preview vs local). |
| Every non-admin login fails on a new site / `no such column: off` | Database was created from an old schema without `users.off`. Run `schema.sql` again (idempotent) and, if the table existed before, `ALTER TABLE users ADD COLUMN off TEXT NOT NULL DEFAULT '[]';`. |
| Emails not arriving | Settings → Resend shows Not connected, or Test connection says the domain is not verified. Check Dashboard → Email health (sent/failed, last error) and the Audit log. Confirm SPF/DKIM records in Cloudflare DNS and that `MAIL_FROM` is on the verified domain. Check spam. |
| Preview deploy writes to live leads | `env.preview.d1_databases[0].database_id` or `env.preview.r2_buckets` still point at live resources, or you are looking at a Workers Builds version preview (`<version>-fuego-steakhouse…workers.dev`), which uses production bindings. Use `npm run deploy:preview` for an isolated preview. |
| Forms show "Please complete the verification step" | `TURNSTILE_SECRET` (or portal secret) is set but the page has no `.cf-turnstile` div/script, the `data-sitekey` is wrong, or the widget hostname list does not include this host (e.g. a new workers.dev preview host). Fix the HTML/widget per §6 or remove the secret. |
| Weekly summary did not send | Automations → Weekly summary: check enabled, last run, last error. The cron only fires when the local hour equals `WEEKLY_SUMMARY_HOUR` in `TIMEZONE` on Monday; changing the hour outside 12–13 UTC requires updating the `crons` entry. Resend must be connected. Use **Run now** to test. |
| Production serves preview bindings (leads land in the preview D1, `BUSINESS_NAME` ends in "(preview)") after a branch push | The non-production build command was `npx wrangler deploy --env preview` (see §11). Workers & Pages → fuego-steakhouse → Settings → Builds: production branch `main`, deploy command `npx wrangler deploy`, non-production ("Version command") `npx wrangler versions upload`. Push to `main` (or redeploy locally with `npm run deploy`) to restore production, then check the preview D1 `leads` table for anything submitted in the window. |
| D1 console rejects the schema | The console accepts one line. Paste the contents of `schema.oneline.sql`, not `schema.sql`. |
| `#set=` link says expired | Token is single use and expires (bootstrap/invite 24 h, reset 15 min). Issue a new one (Team → Reset password, or rerun the bootstrap script). |
| `403 csrf` from the portal | Missing `X-Requested-With` header or `Origin` not equal to `SITE_URL`/request host. Usually a wrong `SITE_URL` var for that environment. |
| `403 origin` on form posts | Site served from a host that is not `SITE_URL`, the request host, `*.workers.dev` or localhost. |
| Analytics "GA4 request failed: … permission" | The service account is not a Viewer on the property, or the property id is the measurement ID (`G-…`) instead of the numeric id. |
| Images uploaded in Media do not load | `media.fuegosteaks.com` custom domain not connected to `fuego-media`, or `MEDIA_URL` mismatch. |

## 14. More documentation

- `docs/api.md` — the API contract (routes, bodies, errors, permissions).
- `docs/launch-playbook.md` — plain-language guide for the restaurant owner / marketing manager.
- `docs/runbook.md` — provisioning a new tenant from this codebase, backups, rollback, migrations, key rotation, monitoring.
