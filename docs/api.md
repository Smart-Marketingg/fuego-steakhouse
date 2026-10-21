# CRM API contract

Everything lives under `/api/`. Responses are JSON unless noted. Times are ISO-8601 UTC strings; the portal renders them in `TIMEZONE`.

## Conventions

- **Auth:** session cookie `crm_session` (HttpOnly, Secure, SameSite=Strict, Path=/). Unauthenticated → `401 {"error":"unauthorized"}`.
- **CSRF:** every non-GET request (except the public `POST /api/lead`, which sends `X-Requested-With: crm-site` and is origin-checked) must send header `X-Requested-With: crm` (exact value) and an `Origin` matching `SITE_URL` (or a `*.workers.dev` preview host). Otherwise `403 {"error":"csrf"}`.
- **Permissions:** checked server-side with `can(user, permission)`. Missing → `403 {"error":"forbidden","need":"leads.export"}`. A hidden section (`users.off`) 403s its routes with `{"error":"section_off"}`.
- **Errors:** `{"error": "<code>", "message": "<human text>"}`. Validation: `400 {"error":"invalid","fields":{"email":"Enter a valid email"}}`.
- **Pagination:** `?page=1&limit=50` → `{"items":[...],"total":123,"page":1,"limit":50}`.
- **Date filter:** `?range=any|24h|today|7d|week|30d|month|lastmonth|90d|year|custom&from=YYYY-MM-DD&to=YYYY-MM-DD` (custom uses from/to in `TIMEZONE`).

### Permissions
`dashboard.view, leads.view, leads.edit, leads.delete, leads.export, notes.add, analytics.view, automations.manage, media.manage, team.manage, settings.manage, audit.view`

Roles: `admin` has every permission. `staff` has `dashboard.view, leads.view, leads.edit, notes.add, analytics.view` plus whatever is in `users.perms`.

### Sections (sidebar; each may be in `users.off`)
`dashboard, leads, analytics, automations, media, team, settings, audit`

---

## Public

### `POST /api/lead`
Accepts `multipart/form-data` or `application/x-www-form-urlencoded`. Same-origin only.

| field | notes |
|---|---|
| `form` | `reservation` \| `event` \| `contact` \| `newsletter` (required) |
| `name,email,phone,date,time,party,guests,subject,message` | per form, see `src/forms.config.js` |
| `website` | honeypot — must be empty |
| `cf-turnstile-response` | required when `TURNSTILE_SECRET` is set |
| `page` | path the form was on |
| `utm_source, utm_medium, utm_campaign, utm_term, utm_content, ref` | attribution |
| `file` | optional PDF/DOC/DOCX ≤ 10 MB |

Responses:
- Browser form post (no `X-Requested-With`) → `303` redirect to `/thank-you?type=<form.thanks>`.
- `fetch` with `X-Requested-With: crm-site` or `Accept: application/json` → `200 {"ok":true,"id":"ld_…","thanks":"reservation"}`.
- `400 {"error":"invalid","fields":{…}}`, `403 {"error":"origin"}`, `429 {"error":"rate_limited","retry_after":600}`, `400 {"error":"turnstile"}`.
- Honeypot filled → `200 {"ok":true}` with nothing stored (bots get a success).

### `GET /api/health` → `{"ok":true,"version":"1.0.0","db":true,"settings_key":true,"integrations":{"resend":bool,"turnstile":bool,"ga4":bool,"anthropic":bool,"google":bool}}`

### `GET /api/config` → form + pipeline labels (public shape of `forms.config.js`). Used by the portal; no secrets.

---

## Auth

| route | body / result |
|---|---|
| `POST /api/auth/login` | `{email,password,remember}` → `{ok:true,user}`; `401 {"error":"bad_credentials"}` (same for unknown email); `429 {"error":"rate_limited"}` |
| `POST /api/auth/logout` | → `{ok:true}`, clears cookie |
| `POST /api/auth/logout-all` | → `{ok:true}` deletes every session of the user |
| `GET /api/auth/me` | → `{user:{id,email,name,role,perms,off}, permissions:[…], sections:[…], integrations:{…}, business:{name,site_url,timezone,phone,address}}` |
| `POST /api/auth/ping` | touches `sessions.last_seen` → `{ok:true}`; `401` when idle-expired |
| `POST /api/auth/set/check` | `{token}` → validate a setup/invite/reset token without consuming it → `{ok:true,email,kind}` or `410 {"error":"expired"}` (POST so the token never sits in a URL or request log) |
| `POST /api/auth/set` | `{token,password}` → sets password, consumes token, signs in → `{ok:true}` |
| `POST /api/auth/forgot` | `{email}` → always `{ok:true}`; emails a 15-minute reset link if the user exists |
| `GET /api/auth/google` | 302 to Google (only when configured; else `404`) |
| `GET /api/auth/google/callback` | signs in an existing active user, 302 `/admin/`; otherwise 302 `/admin/#error=google` |

Password rules: ≥ 10 characters. Sessions: 12 h, or 30 d with `remember`. Idle sign-out after 30 min unless `remember`.

---

## Dashboard — `dashboard.view`
`GET /api/dashboard?range=…` →
```json
{"new":4,"in_range":12,"range_label":"This week","by_form":{"reservation":{"total":5,"won":1},"event":{...}},
 "email":{"connected":true,"sent":14,"failed":0,"last_error":null,"last_sent_at":"…"},
 "recent":[{"id":"…","action":"stage","detail":"…","lead_id":"…","lead_name":"…","user_name":"…","created_at":"…"}],
 "warnings":["Resend not connected"]}
```

## Leads — `leads.view`
- `GET /api/leads?form=&pipeline=&stage=&range=&from=&to=&q=&page=&limit=&sort=` → `{items:[lead…], total, counts:{by_form:{reservation:5,…}, by_stage:{new:3,…}}}`
  Lead shape: `{id,created_at,updated_at,form,form_label,pipeline,stage,stage_label,name,email,phone,topic,message,fields:{…},has_file,file_name,page,utm:{…},email_status}`.
- `GET /api/leads/export.csv?…same filters` — `leads.export`; `text/csv`; audited.
- `GET /api/leads/:id` → `{lead, notes:[{id,body,user_name,created_at}], activity:[{action,detail,user_name,created_at}]}`
- `PATCH /api/leads/:id` `{stage}` — `leads.edit` → `{ok:true,lead}`
- `POST /api/leads/:id/notes` `{body}` — `notes.add` → `{ok:true,note}`
- `DELETE /api/leads/:id` — `leads.delete` (admin) → `{ok:true}`; also deletes the attachment.
- `GET /api/leads/:id/file` — `leads.view`; streams the attachment with `Content-Disposition: attachment`; `Cache-Control: no-store`.

## Analytics — `analytics.view`
`GET /api/analytics?range=7d|28d|90d` → `{"connected":false,"reason":"GA4 not connected"}` or
`{"connected":true,"cached_at":"…","range":"28d","totals":{"sessions":n,"users":n,"conversions":n},"top_pages":[{"path","views"}],"sources":[{"source","sessions"}],"daily":[{"date","sessions","users"}],"leads_by_source":[{"source","leads"}]}`

## Automations — `automations.manage`
- `GET /api/automations` → `{templates:{reservation:{enabled,subject,body},…}, weekly:{enabled,last_run_at,recipients}, placeholders:["{first_name}","{name}","{email}","{date}","{time}","{party}","{guests}","{subject}","{business}","{phone_number}","{for_date}"], ai_connected, email_connected}`
- `PUT /api/automations` `{templates?, weekly?}` → `{ok:true}`
- `POST /api/automations/preview` `{form, subject?, body?}` → `{html, subject}`
- `POST /api/automations/test` `{form, to}` → `{ok:true}` or `{error:"not_connected"}`
- `POST /api/automations/weekly/run` → runs the weekly summary now → `{ok:true, sent_to:[…]}`

## Media — `media.manage`
- `GET /api/media` → `{items:[{key,name,type,size,url,uploaded_by,at}]}`
- `POST /api/media` multipart `file` (+ optional `key` to replace) → `{ok:true,item}`
- `DELETE /api/media?key=<encoded key>` (keys contain slashes) → `{ok:true}`; `DELETE /api/media/:key` also works for keys without slashes

## Team — `team.manage`
- `GET /api/team` → `{items:[{id,email,name,role,perms,off,active,created_at,last_login,has_password}]}`
- `POST /api/team/invite` `{email,name,role,perms,off}` → `{ok:true,user,link?}` (link returned only when Resend is not connected so the admin can send it by hand)
- `PATCH /api/team/:id` `{name?,role?,perms?,off?,active?}` → `{ok:true,user}` (cannot deactivate/demote the last active admin)
- `POST /api/team/:id/reset` → emails/returns a reset link
- `POST /api/team/:id/signout` → deletes all of that user's sessions

## Settings — `settings.manage`
- `GET /api/settings` →
```json
{"business":{"name":"…","site_url":"…","address":"…","phone":"…","timezone":"…","mail_from":"…","mail_reply_to":"…"},
 "notify_emails":"info@…","notify_routes":{"event":"events@…"},
 "keys":{"resend":{"set":true,"last4":"ab12","source":"secret"},"turnstile":{…},"ga4":{…},"anthropic":{…},"google":{…}},
 "turnstile_site_key":"0x…"}
```
  `source` is `secret` (Cloudflare secret wins), `portal` (encrypted in D1) or `none`.
- `PUT /api/settings` `{notify_emails?, notify_routes?, turnstile_site_key?, keys?:{resend_api_key?, turnstile_secret?, anthropic_api_key?, ga_service_account?, ga4_property_id?}}` → `{ok:true}`. Keys are encrypted with `SETTINGS_KEY` before storage; an empty string removes a portal value.
- `POST /api/settings/test/:integration` (`resend|ga4|anthropic|turnstile`) → `{ok:true,detail:"…"}` or `{ok:false,error:"…"}`

## Audit — `audit.view`
- `GET /api/audit?action=&user=&range=&from=&to=&q=&page=&limit=` → `{items:[{id,at,user_id,user_name,action,target,detail}], total, actions:[…]}`
- `GET /api/audit/export.csv?…` → CSV

### Audit actions written by the API
`login_ok, login_fail, logout, logout_all, password_set, invite, reset_link, user_update, user_signout, lead_stage, lead_note, lead_delete, lead_export, settings_update, settings_test, automation_update, automation_test, media_upload, media_delete, audit_export, weekly_summary`
