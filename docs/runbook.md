# Runbook — provisioning a new tenant from this codebase, and operating an existing one

Engineer level. Read `README.md` first for how the system works; this document is the procedure for cloning it for another business and for day-2 operations (backups, rollback, migrations, key rotation, monitoring).

## 1. Clone the repo for a new business

1. Create a new **private** GitHub repo under the agency org (`Smart-Marketingg/<client>-site`). Copy this repo's tree into it (`git clone` then change the remote, or GitHub "Use this template" if the source is a template). Do not fork the Fuego repo publicly.
2. Delete the Fuego-specific non-live folders before the first commit: `export/`, `site/`, `screenshots/`, `uploads/`, `_ds/`, `github.md`, `google-sheet-script.gs`, `SETUP-Google-Sheet.txt`, `Fuego Steakhouse (Canva).html`, `tweaks-*.jsx`, `.DS_Store`.
3. Create branch `dev` from `main`; protect `main` (require PR).

## 2. What to change (configuration only)

| File | Change |
|---|---|
| `wrangler.jsonc` | `name` (Worker), `routes` (the client's www + apex with `custom_domain: true`), every `vars` entry (`SITE_URL`, `BUSINESS_*`, `NOTIFY_EMAILS`, `NOTIFY_ROUTES`, `MAIL_FROM`, `MAIL_REPLY_TO`, `TIMEZONE`, `GA4_PROPERTY_ID`, `MEDIA_URL`, `BRAND_*`, `LOGO_URL`, `WEEKLY_SUMMARY_HOUR`), D1 `database_name`/ids, R2 bucket names, and the whole `env.preview` block (name `<worker>-preview`, its own vars, D1 id, bucket names). Adjust `triggers.crons` if `TIMEZONE`/`WEEKLY_SUMMARY_HOUR` means 8:00 local is not within 12–13 UTC (the Worker only sends when the local hour matches; the cron must fire at the UTC hours that cover DST and standard time). |
| `src/forms.config.js` | The client's forms (`fields`, `topicFrom`, `autoReply` defaults, `thanks`) and pipelines (five stage labels each, `wonLabel`). Form ids must match the `form` value the site posts. Alternatively leave the file and set the `FORMS_JSON` var to an object of the same shape (functions such as `topicFormat` cannot be expressed in JSON; the code then shows the raw topic value). |
| Site files at the root | The client's HTML/CSS/JS. Keep `lead.js` and `thank-you.js`; wire each form to `window.FuegoLead.submit(formEl, '<form id>')` (see `app.js`), keep the `.cf-turnstile` placeholders, keep `/thank-you`, `robots.txt` (disallow `/admin/`, `/api/`, `/thank-you`) and `sitemap.xml`. Update `_redirects` or remove it. |
| `thank-you.js` | Per-form confirmation copy and CTAs. |
| `lead.js` | `FORM_IDS` and the fallback phone number in `ERROR_MESSAGE`. |
| `admin/index.html`, `admin/admin.css` | `<title>`, logo path (`/assets/…`), fonts/colors so the portal matches the client's design system. `admin.js` reads business name, forms and pipelines from the API; it should not need edits. |
| `.assetsignore` | Keep the first block as is; update the "non-live" block for whatever drafts exist in the new repo. |
| `scripts/bootstrap-admin.mjs` | The printed link hard-codes `https://www.fuegosteaks.com`; change it or just replace the host when opening the link. |
| `package.json` | `name`, `description`, and the D1 names in `schema:local`, `schema:preview`, `schema:live`. |
| `README.md`, `docs/` | Names, domains, addresses. |

### What must NOT be edited

The Worker modules in `src/` other than `forms.config.js` (`worker.js`, `router.js`, `util.js`, `auth.js`, `leads.js`, `email.js`, `settings-crypto.js`, `settings.js`, `analytics.js`, `automation.js`, `media.js`, `team.js`, `headers.js`, `audit.js`) contain nothing business-specific; every default comes from vars. If a tenant needs behaviour the vars cannot express, change it in the Fuego repo first (so every tenant benefits and the modules stay diffable), then copy the file over. In particular keep `can(user, permission)` two-argument and keep the roles/permissions defined only in `auth.js`.

## 3. Create Cloudflare resources

Replace `<worker>` with the new Worker name and `<media>`/`<private>` with the bucket names in `wrangler.jsonc`.

Use Node 20 or newer locally (`nvm use 20`); Node 18 makes every asset subfolder 404 in `wrangler dev` (see README §10).

```bash
npm install
npx wrangler login
npx wrangler d1 create <worker>
npx wrangler d1 create <worker>-preview
npx wrangler r2 bucket create <media> --location enam
npx wrangler r2 bucket create <media>-preview --location enam
npx wrangler r2 bucket create <private> --location enam
npx wrangler r2 bucket create <private>-preview --location enam
```

Paste the two D1 ids into `wrangler.jsonc` (live: `database_id`; preview: `preview_database_id` and `env.preview…database_id`). Pick the location hint nearest the client (`enam`, `wnam`, `weur`, …).

## 4. Secrets

```bash
openssl rand -base64 32    # once per environment
npx wrangler secret put SETTINGS_KEY
npx wrangler secret put SETTINGS_KEY --env preview
```

Optional, when available: `RESEND_API_KEY`, `TURNSTILE_SECRET`, `GA_SERVICE_ACCOUNT`, `ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, each with and without `--env preview`. Record which key was set where in the agency password manager, never in the repo. Keys can also be entered later in the portal (encrypted in D1); a Cloudflare secret always overrides a portal value.

## 5. Schema and bootstrap

```bash
npm run schema:live        # wrangler d1 execute <worker> --remote --file=schema.sql
npm run schema:preview
npm run schema:local       # for wrangler dev
```

Or paste the single line of `schema.oneline.sql` into the D1 console (one line only). Then deploy once and bootstrap:

```bash
npx wrangler deploy
npx wrangler deploy --env preview
node scripts/bootstrap-admin.mjs owner@client.com "Owner Name"
npx wrangler d1 execute <worker> --remote --command "<printed SQL>"
```

Open `https://www.<client-domain>/admin/#set=<token>` within 24 hours. Repeat against `<worker>-preview` for the preview portal if needed.

## 6. DNS and domains

1. The zone must be on the same Cloudflare account as the Worker. If the site was on Cloudflare Pages, remove the custom domain from the Pages project first.
2. `routes` with `custom_domain: true` create the www and apex records on deploy. Check Worker → Settings → Domains & Routes.
3. R2 → `<media>` → Settings → Custom Domains → connect `media.<client-domain>`; set `MEDIA_URL` accordingly.
4. Resend: Domains → Add `<client-domain>` → add the SPF/DKIM records it shows in Cloudflare DNS (DNS only / grey cloud) → wait for Verified. `MAIL_FROM` must be on that domain. Add the API key, press Test connection in Settings.
5. Turnstile: create a widget for the www host (plus the preview workers.dev host for testing). Secret → `TURNSTILE_SECRET`; site key → Settings → Turnstile site key and the `data-sitekey` in each form's `.cf-turnstile` div; uncomment the script tag. Add the WAF rate-limit rule: Security → WAF → Rate limiting rules → expression `(http.request.uri.path eq "/api/lead" and http.request.method eq "POST")`, 10 requests / 1 minute per IP, Block for 1 hour.
6. GA4 (optional): Google Cloud project (no organization if a Workspace policy blocks key creation) → enable Google Analytics Data API → service account + JSON key → grant Viewer under GA Admin → Property access management → numeric property id from Property settings → `GA_SERVICE_ACCOUNT` secret + property id in Settings.
7. Google sign-in (optional): OAuth client of type Web application with redirect URI `https://www.<client-domain>/api/auth/google/callback` (and the preview URL's callback for preview); set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`.

## 7. Workers Builds

Workers & Pages → Create → Import a repository → the new repo.

| Setting | Value |
|---|---|
| Worker name | `<worker>` (must equal `name` in `wrangler.jsonc`) |
| Production branch | `main` |
| Root directory | `/` (or the site folder if the repo nests it; then `assets.directory` must match) |
| Build command | empty |
| Deploy command | `npx wrangler deploy` |
| Non-production branch deploy command | `npx wrangler deploy --env preview` |

Push `dev`, confirm a preview deploy appears on the PR, merge to `main`, confirm production.

## 8. Smoke test checklist

Run against production (and preview if secrets were set there).

- [ ] `curl -s https://www.<domain>/api/health` → `{"ok":true,"db":true,"settings_key":true,"integrations":{…}}`
- [ ] `curl -I https://<apex-domain>/` → `301` to www
- [ ] `curl -I https://www.<domain>/schema.sql`, `/src/worker.js`, `/wrangler.jsonc`, `/docs/api.md` → all `404`
- [ ] `curl -I https://www.<domain>/admin/` → `200` with `Content-Security-Policy`, `Cache-Control: no-store`, `X-Robots-Tag: noindex`
- [ ] Submit each form from the live site (one lead per form id). Expected: redirect to `/thank-you` with the per-form copy.
- [ ] Each lead is in D1: `npx wrangler d1 execute <worker> --remote --command "SELECT id, form, stage, email_status, created_at FROM leads ORDER BY created_at DESC LIMIT 10"`
- [ ] Notification email arrived at `NOTIFY_EMAILS` / routed address; auto-reply arrived at the test address; `email_status = sent`.
- [ ] A direct `curl -X POST https://www.<domain>/api/lead -d 'form=contact'` without `Origin` → `403 origin`; six quick valid posts from one IP → the sixth is `429`.
- [ ] `/admin/`: sign in, Dashboard shows the test leads, move a lead through all five stages, add a note, open the event attachment, Export CSV.
- [ ] Team: invite a staff user, sign in as them, confirm `GET /api/settings` → `403 forbidden` and that a hidden section → `403 section_off`.
- [ ] Settings → Test connection for every configured integration.
- [ ] Automations → Run now sends the weekly summary.
- [ ] Mobile viewport: no horizontal scroll on the site or the portal.
- [ ] Delete the test leads (admin → Delete) or leave them in Closed.

## 9. Rollback

- Worker code: `npx wrangler deployments list` then `npx wrangler rollback [<deployment-id>]` (add `--env preview` for preview). Rollback restores code and bindings of that deployment, not D1 data.
- D1 data: Time Travel keeps 30 days of history on paid plans.
  ```bash
  npx wrangler d1 time-travel info <worker>
  npx wrangler d1 time-travel restore <worker> --timestamp "2026-10-21T13:00:00Z"
  ```
  Restoring overwrites the whole database; take an export first (section 10).
- Git: revert the merge commit on `main` and push; Workers Builds redeploys.

## 10. Backups

```bash
npx wrangler d1 export <worker> --remote --output backups/<worker>-$(date +%F).sql
```

Store the file outside the repo (it contains PII and password hashes). Schedule it weekly from an agency machine or CI. R2 objects (`<private>` attachments, `<media>` images) can be copied with `npx wrangler r2 object get` per key or with an S3-compatible sync tool using an R2 API token. Portal-entered keys in `settings` are encrypted with `SETTINGS_KEY`; keep that key in the password manager, otherwise a restored database cannot decrypt them.

## 11. Migrations convention

- `schema.sql` is the full, idempotent schema of a fresh database and must always create every column the code reads. Every change to it must also be expressed as a migration for existing databases.
- Migrations live in `migrations/NNNN-name.sql` (`0001-add-leads-source.sql`, zero-padded, ascending). Each migration is idempotent where SQLite allows it (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`); for `ALTER TABLE … ADD COLUMN`, which is not idempotent in SQLite, note in a header comment that it fails harmlessly with `duplicate column name` on a database that already has it.
- Procedure: edit `schema.sql` → add `migrations/NNNN-name.sql` → `npm run schema:oneline` → commit all three → apply the migration to preview (`npx wrangler d1 execute <worker>-preview --remote --file=migrations/NNNN-name.sql`), deploy preview, test → apply to live, merge, deploy.
- Never drop or rename columns in a single step; add the new column, deploy code that writes both, backfill, then remove the old one in a later release.

## 12. Rotating SETTINGS_KEY

`SETTINGS_KEY` encrypts portal-entered integration keys (AES-GCM, key derived by SHA-256 of the secret) and salts IP hashes. Old ciphertext cannot be read with a new key; the code returns `null` for undecryptable values, so those integrations silently become "Not connected".

1. Before rotating, open Settings and note which integrations show `source: portal` (these will need re-entering) and which show `secret` (unaffected).
2. `openssl rand -base64 32` → `npx wrangler secret put SETTINGS_KEY` (and `--env preview` with its own value).
3. Re-enter every `portal` key in Settings → Integrations (Resend, Turnstile secret, Anthropic, GA service account, Google client id/secret) and press Test connection on each. Plain settings (notification emails, routes, templates, Turnstile site key, GA4 property id, weekly summary config) are stored unencrypted with a `plain:` prefix and survive rotation.
4. IP-based rate-limit windows reset (hashes change); nothing to do.
5. Record the rotation in the password manager.

## 13. Monitoring

- Dashboard → Workers & Pages → `<worker>` → **Observability / Logs**: `observability.enabled` is on, so `console.error('unhandled', …)`, `background task failed`, `weekly summary failed` and the per-run `weekly summary {…}` JSON appear there. Filter by `$workers.outcome = exception` for crashes.
- Live tail during a change:
  ```bash
  npx wrangler tail <worker> --format pretty
  npx wrangler tail <worker> --env preview
  ```
- Inside the app: Dashboard warnings and email health; Audit log (`login_fail`, `settings_test`, `weekly_summary`, exports); `email_log` table for every send attempt.
- `GET /api/health` is public and cheap; point an external uptime monitor at it (expect `"ok":true,"db":true`). It also reports `settings_key` and per-integration connected flags without exposing values.
- Cron: Worker → Settings → Triggers shows the last cron runs; Automations → Weekly summary shows `last_run_at`/last error.
- Quotas to watch on the free/paid Workers plan: D1 rows read (dashboard counts and lead lists are indexed), R2 Class A operations (uploads), Resend monthly sends.

## 14. Known pitfalls

From the original build spec and from this codebase:

- Schema missing columns the code uses (historically `users.off`) → every non-admin login fails on a new site. `schema.sql` is the full schema; rerun it when in doubt, it is idempotent.
- Sender address or business name hard-coded as a default in automation code. All defaults come from vars; keep it that way when editing templates.
- `/api/lead` without per-IP rate limiting or bot protection. The D1 limit is built in; the WAF rule and Turnstile are per-tenant setup steps that are easy to forget.
- Preview builds bound to live D1/R2. Check `env.preview` ids and bucket names before the first preview deploy, and that the non-production deploy command includes `--env preview`.
- Generated code calling `can()` with a different number of arguments than the backend defines. It is `can(user, permission)`; routes use `requirePerm('<permission>')`.
- The D1 console only accepts a single line of SQL. Use `schema.oneline.sql`.
- If `dev` and `main` show conflicts nobody caused, reset `dev` to `main` (`git reset --hard origin/main` + `--force-with-lease`) instead of resolving.
- Turnstile secret set before the widget is on the page → every form submission fails with `turnstile`.
- `SITE_URL` wrong for an environment → `403 csrf`/`403 origin` everywhere in that environment, and emailed links point to the wrong host.
- The cron fires at fixed UTC hours; changing `TIMEZONE` or `WEEKLY_SUMMARY_HOUR` without changing `triggers.crons` means the weekly summary never matches the hour and never sends.
- Rotating `SETTINGS_KEY` without re-entering portal keys → integrations silently show Not connected.
- `GA4_PROPERTY_ID` must be the numeric property id, not the `G-…` measurement id.
- Running `wrangler dev` on Node 18 → `assets/` and `admin/` 404 locally (recursive `readdir` ignored). Node 20+ only.
- Invite/reset links are shown in the admin UI when Resend is not connected; they are still single use and time-limited, treat them as passwords.
