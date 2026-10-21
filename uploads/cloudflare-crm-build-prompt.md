# Reusable prompt — Website + CRM portal on Cloudflare (Smart Marketing stack)

Copy everything inside the box into a new project, fill in the `[BRACKETS]`, and attach or link the website. Delete any optional module you don't want for that client.

Need super admins and the shutdown switch? Paste the contents of `super-admin-addon.md` inside the same box, right after the "Known pitfalls" section.

---

```
Build a website-plus-CRM that runs entirely on Cloudflare: one Worker serves the static site AND the API, D1 is the database, R2 stores files, and the code lives in a private GitHub repo with a Dev -> main workflow. Match the site's design exactly and follow every requirement below.

Do NOT use Google Sheets, Google Apps Script, Formspree, Netlify Forms, Zapier or any other third-party form backend. D1 is the single source of truth for leads. Email goes out through Resend from the Worker.

## Business details
- Business name: [BUSINESS NAME]
- Live domain: [https://www.example.com] (apex [example.com] redirects to www)
- Worker name: [example-site]
- GitHub repo: [Org/Repo]   Site folder inside the repo: [folder name or "/"]
- Website source: [the repo above OR "the attached files"]
- First admin email (bootstrapped at launch): [owner@example.com]
- Lead notification email(s) (receive every submission): [owner@example.com]
- Sending address for emails (MAIL_FROM): [Business Name <hello@example.com>]
- Reply-to for auto-replies: [frontdesk@example.com]
- Time zone for dates and the weekly job: [America/New_York]
- Business address + phone for email footers: [123 Main St, City, ST 00000 · (555) 555-5555]
- GA4 property ID: [123456789] (or "none")
- Public media domain: [media.example.com]
- R2 location hint: [ENAM]

## Forms to capture
List every form on the site and its fields. Reuse the site's existing forms where they exist.
- [Contact / New patient form]: name, email, phone, [interest dropdown options], message, consent checkbox
- [Careers form]: name, email, phone, message, resume upload (PDF/DOC/DOCX, max 10MB)
- [Any other form]: [fields]

## Pipelines (one per form type)
Exactly 5 stages per pipeline, stored internally as new / contacted / scheduled / won / closed, with these display labels:
- [Leads] pipeline ([Contact form]): [New lead] -> [Contacted] -> [Consultation booked] -> [Patient] -> [Closed]
- [Hiring] pipeline ([Careers form]): [Applied] -> [Contacted] -> [Interview] -> [Hired] -> [Not a fit]

## 1. Architecture and hosting
- One Worker (`src/worker.js` + modules) with an `assets` binding for the static site. Routes: `/api/*` -> Worker code; everything else -> assets with clean URLs (/about, /services/x, /admin/). Old `#/` links redirect to clean paths.
- `wrangler.jsonc` contains: name, main, compatibility_date, assets dir pointing at the site folder, custom domain route, cron trigger for the weekly job, and bindings:
  - D1 `DB` (live database [example])
  - R2 `MEDIA` (public images, served at MEDIA_URL) and R2 `PRIVATE` (resumes/attachments, no public access, served only through an authenticated API route)
  - a `previews` block that binds SEPARATE preview copies: D1 [example-preview], R2 [example-media-preview], [example-private-preview]. Preview builds must never touch live data.
- `.assetsignore` keeps worker code, schema files, wrangler.jsonc, README, docs, tests, .git*, .DS_Store and any backups from being served publicly.
- Deploy through Cloudflare Workers Builds connected to GitHub: `main` deploys production, every other branch (Dev) gets a preview URL posted on the PR.
- Repo contains only live files. No `deploy/`, `export/`, drafts, backups or `.DS_Store`.

## 2. Configuration (vars vs secrets)
Vars (wrangler.jsonc): SITE_URL, NOTIFY_EMAILS, MAIL_FROM, MAIL_REPLY_TO, TIMEZONE, GA4_PROPERTY_ID, MEDIA_URL, BUSINESS_NAME, BUSINESS_ADDRESS.
Secrets (Cloudflare dashboard / `wrangler secret put`, never in the repo): SETTINGS_KEY, RESEND_API_KEY, TURNSTILE_SECRET, GA_SERVICE_ACCOUNT, ANTHROPIC_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.
- Nothing business-specific is hard-coded in JS. Every default (sender address, names, colors in emails) comes from vars, so the codebase can be cloned to a new site by changing config only.
- The app must boot and work with only SETTINGS_KEY set; every other integration is optional and shows "Not connected" in the portal instead of erroring.
- API keys typed into the portal's Settings page are encrypted with AES-GCM using SETTINGS_KEY before being stored in D1. A Cloudflare secret, if present, always overrides the portal value. Keys are never returned to the browser in full (show last 4 only).

## 3. Database (D1)
Produce `schema.sql` (idempotent: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS) that creates EVERY column the code reads, including `users.off`. Also produce `schema.oneline.sql`, the same schema flattened to a single line for the D1 console (newlines inside text written as char(10)), and `migrations/` for any later changes.
Tables (at minimum): users (id, email, name, pass_hash, salt, role, perms JSON, off JSON NOT NULL DEFAULT '[]', active, created_at, last_login), sessions (token_hash, user_id, expires_at, remember, ip_hash, ua), set_tokens (one-time setup/reset/invite links, hashed, expiry, single use), leads (id, created_at, form, pipeline, stage, name, email, phone, topic, message, fields JSON, file_key, page, utm JSON, ip_hash, spam_score), notes (lead_id, user_id, body, created_at), activity (lead_id, user_id, action, detail, created_at), settings (key, enc_value, updated_by, updated_at), auth_attempts (scope, key_hash, at, ok), audit_log (user_id, action, target, detail, ip_hash, at), media (key, name, type, size, uploaded_by, at).
Store IP addresses only as salted hashes.

## 4. Lead capture: POST /api/lead
- Same-origin only (check Origin against SITE_URL plus *.[worker].workers.dev preview hosts). Accepts multipart or url-encoded.
- Spam: hidden honeypot field `website`; Cloudflare Turnstile verified server-side when TURNSTILE_SECRET is set; per-IP rate limit in D1 (e.g. 5 per 10 minutes) AND document a Cloudflare WAF rate-limit rule for /api/lead in the README.
- Validate email/phone, cap the length of every field, strip control characters.
- Uploads: PDF/DOC/DOCX only, verified by magic bytes not just extension, max 10MB, stored in the PRIVATE bucket under a random key. Staff open them only through an authenticated, short-lived download route.
- Insert into D1, then send (via ctx.waitUntil so the visitor isn't kept waiting):
  - Branded notification email to NOTIFY_EMAILS: logo, brand colors and fonts, eyebrow label per form, name as headline, field table with clickable email/phone, message box, "Reply to {first name}" and "Open in CRM" (deep link to /admin/#lead=<id>) buttons, footer with address. Table layout + bgcolor attributes for email clients. Inside single-quoted style attributes never use single-quoted font names; use &quot; instead. Attach the resume when there is one. Subject "[Business] - [Form] - [Name]", replyTo the submitter.
  - Optional auto-reply to the submitter (per-form template editable in the portal).
- If Resend is not configured or fails, the lead is still saved and the failure is logged and shown on the dashboard. A lead is never lost because email failed.
- On success the site redirects to `/thank-you` (sessionStorage `fn-thanks` = form type so copy changes per form). Thank-you page: site design, success mark, "Thank you." headline, per-form message, 3 "what happens next" steps, 2 CTAs, noindex.
- Capture UTM params and landing page from the visitor's session for attribution.

## 5. Authentication and roles
- Portal at `/admin/`. Email + password sign-in. Passwords hashed with PBKDF2-SHA256 via WebCrypto (100,000 iterations, the Workers maximum) with a per-user salt; constant-time comparison.
- Sessions: random token in an HttpOnly, Secure, SameSite=Strict cookie; only the SHA-256 hash is stored in D1. 12 hours, or 30 days with "Keep me signed in". 30-minute idle sign-out unless remembered. Sign out and "sign out everywhere".
- Login rate limit: 5 failed attempts per 15 minutes per email and per IP; every attempt written to auth_attempts / audit_log. Same generic error for wrong email or wrong password.
- First admin bootstrap: a CLI/console step inserts the hash of a one-time token for the first admin email; opening `/admin/#set=<token>` lets that person set their password. The token is read from the hash, exchanged, then removed from the address bar. Same flow for invites and password resets (15-minute, single-use links, emailed via Resend).
- Optional "Sign in with Google" (only when GOOGLE_CLIENT_ID/SECRET exist), allowed only for emails that already have an active user row. Never auto-creates accounts.
- Roles: admin and staff. Admins manage the team, settings and the audit log; staff work leads within the permissions they're given.
- Permission check is a single function with a fixed TWO-argument signature: `can(user, permission)`. Every API route enforces it server-side; the UI only hides what the API already blocks. Keep roles defined in one place so more roles can be added later without touching every route.
- Per-person sidebar sections: admins can hide sections per user (stored in `users.off`); hidden sections are enforced by the API, not just the menu.

## 6. Portal sections
Header: logo, sync status, Refresh, user menu, Lock. Sidebar sections (each can be turned off per user):
- Dashboard: New, This week (becomes "In range" with a date filter), counts per form type, email delivery health, recent activity.
- Leads:
  - Toolbar: List / Pipeline toggle; form-type tabs with counts; stage filter; date filter (Any time, Last 24 hours, Today, Last 7 days, This week, Last 30 days, This month, Last month, Last 90 days, This year, Custom range); search; Clear filters; Export CSV of the current filter (permission-gated, logged).
  - List view: table on desktop (contact, form, interest, stage pill, received); cards on mobile.
  - Pipeline view: pipeline tabs with counts and conversion rate ("33% booked · 2 of 6"); 5 columns, drag-and-drop on desktop, stacked on mobile.
  - Detail panel (sticky side panel in list view, drawer in pipeline view, full screen on mobile): name, form, date, Reply by email (mailto with subject), Call, 5-step stage stepper with equal columns, fields, message, attachment Open (authenticated route), notes with author and timestamp, activity history, Delete with confirmation (admin only).
- Analytics (optional): GA4 Data API, authenticated by signing a JWT for the GA_SERVICE_ACCOUNT inside the Worker (WebCrypto RS256, no SDK). Sessions, users, top pages, sources, conversions, lead counts by source. Cache responses in D1 or the Cache API for 15 minutes.
- Automations (optional): per-form auto-reply templates with preview and test send; weekly AI summary (cron, Monday [8:00] in TIMEZONE) that uses ANTHROPIC_API_KEY to summarize last week's leads and analytics and emails it to admins.
- Media (optional): upload/replace site images to the MEDIA bucket, served from MEDIA_URL; copy-link button.
- Team (admin): users, invites, roles, permissions, hidden sections, deactivate, reset password, force sign-out.
- Settings (admin): business info, notification emails, integration keys (encrypted), connection tests for Resend/GA4/Anthropic/Turnstile.
- Audit log (admin): filterable, exportable.

## 7. Security headers and SEO
- Set in the Worker for every response: HSTS, X-Content-Type-Options nosniff, Referrer-Policy strict-origin-when-cross-origin, Permissions-Policy, X-Frame-Options SAMEORIGIN.
- /admin/* and /api/*: X-Robots-Tag noindex, Cache-Control no-store, frame-ancestors 'none', Referrer-Policy no-referrer, and a strict CSP allowing only 'self', Google Fonts, challenges.cloudflare.com (Turnstile) and MEDIA_URL. No inline scripts in the portal.
- All state-changing API calls require the session cookie plus a CSRF header check (custom header + Origin match).
- robots.txt disallows /admin/ and /api/; sitemap.xml excludes /admin and /thank-you.

## 8. Design
- The portal uses the website's own design system: fonts, colors, buttons, inputs, radii, spacing, logo. Read the site's CSS/tokens first and reuse its classes. Do not introduce a different visual style. Match the site's light/dark mode.
- Fully responsive, no horizontal scrolling on mobile; boards stack, tables become cards.
- Every empty, loading, error and "not connected" state is designed.

## 9. Files to produce
- `wrangler.jsonc`, `.assetsignore`, `package.json` (wrangler + test runner only), `src/` (worker, router, auth, leads, email, analytics, automation, settings-crypto, headers modules), `schema.sql`, `schema.oneline.sql`, `migrations/`, site files with wired forms, `/thank-you`, `/admin/` portal, `robots.txt`, `sitemap.xml`, `tests/`.
- `README.md`: architecture diagram; creating D1/R2 (live + preview) and binding them; vars and secrets; connecting GitHub to Workers Builds; running the schema (console one-liner); bootstrapping the first admin; adding team members; Resend domain verification (SPF/DKIM); Turnstile site key; GA4 service account (create it in a Cloud project with no organization if a Workspace policy blocks key creation; grant Viewer on the property); WAF rate-limit rule; Dev -> main workflow; troubleshooting.
- `docs/launch-playbook.md` (plain language, for the client) and `docs/runbook.md` (engineer level: provisioning a new tenant from this codebase).

## 10. Verify before handing off
Run locally with `wrangler dev` against the preview bindings and confirm, with no console errors:
- Each form saves to D1, sends the notification (or logs a clear failure), and redirects to /thank-you; honeypot, Turnstile and rate limit block spam.
- Bootstrap, sign-in, remember-me, idle timeout, rate limiting, invites, password reset, sign out everywhere.
- Roles and hidden sections are enforced by the API (call routes directly with a staff session).
- Filters, CSV export, pipeline drag-and-drop, stage stepper, notes, attachment download.
- Mobile has no horizontal scroll; Lighthouse accessibility >= 90 on the portal.
- A fresh database created from schema.sql alone supports every feature (no missing columns).
- No secret, schema or worker file is reachable as a public URL.
Report results as a checklist.

## Known pitfalls (do not repeat)
- Schema missing columns the code uses (e.g. users.off) -> every non-admin login fails on a new site.
- Sender address or business name hard-coded as a default in automation code.
- /api/lead without per-IP rate limiting or bot protection.
- Preview builds bound to live D1/R2.
- Generated code calling `can()` with a different number of arguments than the backend defines.
- The D1 console only accepts a single line of SQL.
- If Dev and main show conflicts nobody caused, reset Dev to main instead of "resolving" them.
```

---

## After the build — owner checklist

1. Push to the private GitHub repo on `Dev`. Make sure `main` is protected and the repo is private.
2. In Cloudflare: create D1 (live + preview) and R2 buckets (media public, private, plus preview copies); put their IDs in `wrangler.jsonc`.
3. Connect the repo in **Workers & Pages → Create → Import a repository** (production branch `main`, root = site folder).
4. Add secrets: at minimum `SETTINGS_KEY` (random 32 bytes, base64). Then `RESEND_API_KEY`, `TURNSTILE_SECRET`, `GA_SERVICE_ACCOUNT`, `ANTHROPIC_API_KEY` as needed.
5. Run `schema.oneline.sql` in the D1 console for both live and preview databases.
6. Bootstrap the first admin and open `/admin/#set=<token>` to set the password.
7. Verify the sending domain in Resend (SPF/DKIM), add the Turnstile site key to the forms, add the WAF rate-limit rule for `/api/lead`.
8. Add the custom domain and the media domain.
9. Send a test from each form, check the email and the CRM, then open a PR Dev → main, test the preview URL, and merge.
