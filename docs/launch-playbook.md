# Fuego Steakhouse & Bar — CRM launch playbook

For the owner and the marketing manager. No technical background needed. Where this guide says "ask Smart Marketing", that is the team that built and maintains the site.

## 1. What you're getting

- Your website at **www.fuegosteaks.com** now has its own private back office, the **CRM**, at **www.fuegosteaks.com/admin**. It is part of the website itself; there is no separate vendor login and nothing to install.
- Every request a guest sends through the website lands in the CRM as a **lead**, with the date, the page it came from and, when available, the ad campaign or source that brought the guest:
  - **Reservation request** (the "Reserve a Table" form on the home page and the menu / gift card pages)
  - **Private event inquiry** (the form on the Private Events page, including an optional attached PDF or Word file)
  - **Contact message** (the Contact page)
  - **Newsletter signup** (the CRM has a pipeline ready for it; today the "Sign Up" button in the footer still goes to your Toast marketing list, so this pipeline stays empty until that is switched over)
- For every lead you also receive an **email notification** with all the details, a "Reply to" button and an "Open in CRM" button. By default it goes to **info@fuegosteaks.com**; private event inquiries go to **events@fuegosteaks.com**. You can change this yourself (section 7).
- Guests get an automatic confirmation email (an **auto-reply**) for reservations, events and contact messages. The wording is yours to edit.
- Once a week, on Monday morning, every admin receives a **weekly summary** email.
- The old Google Sheet and script are no longer used. Leads live only in the CRM.

## 2. Launch day checklist

Accounts involved and who owns them:

| Account | Needed for | Who |
|---|---|---|
| Cloudflare (owns fuegosteaks.com, the site and the database) | Everything | Smart Marketing sets it up; the business should be the account owner or have a login |
| Resend (sends emails) | Notifications, auto-replies, invitations, weekly summary | Smart Marketing creates it; the business pays for it if it grows past the free tier |
| Google Cloud (optional) | Website traffic charts inside the CRM, from your Google Analytics | Needs someone who has admin access to the restaurant's Google Analytics |
| Anthropic (optional) | Turns the weekly summary into a short written recap instead of a list of numbers | Optional; a plain summary is sent without it |

What happens on launch day, in order:

1. Smart Marketing moves the website from the old hosting to the new setup. The address does not change.
2. Smart Marketing verifies `fuegosteaks.com` in Resend so emails come from **info@fuegosteaks.com**. This needs a few DNS records added in Cloudflare; nothing is required from you.
3. Smart Marketing creates your first admin account and sends you a **one-time setup link** (section 3). Only you should open it.
4. You sign in, set your password, then add your team (section 5).
5. Together you send one test through each form (reservation, event, contact) and confirm that:
   - the lead appears in the CRM,
   - the notification email arrived at info@ / events@,
   - the guest's auto-reply arrived at the test address.
6. Optional add-ons, any time after launch: the "I am not a robot" check on the forms (Turnstile), Google Analytics in the CRM, the AI-written weekly summary, "Sign in with Google".

## 3. Your first sign-in

1. You will receive a link that looks like `https://www.fuegosteaks.com/admin/#set=…` followed by a long code. It works **once** and expires after **24 hours**. If it has expired, ask for a new one.
2. Open it, choose a password of **at least 10 characters**, and you are signed in.
3. Next time, go to **www.fuegosteaks.com/admin**, enter your email and password.
4. **Keep me signed in**: tick it on your own computer or phone to stay signed in for 30 days. Leave it unticked on a shared device; a plain session ends when you close the browser, after 12 hours, or after 30 minutes without activity.
5. **Lock (sign out)** is in the user menu at the top right. Use it when stepping away from a shared host-stand computer.
6. Forgot your password? Use **Forgot password** on the sign-in page. A reset link valid for 15 minutes is emailed to you.

## 4. Daily use

### Dashboard

The first screen. It shows how many leads are still **New** (nobody has acted on them yet), how many came in this week, a count per form, whether emails are being delivered (sent / failed in the last 7 days), and the latest activity. Yellow warnings at the top tell you when something needs attention, for example "Resend is not connected".

### Working a lead

Open **Leads**. You can switch between a **List** (newest first) and a **Pipeline** board (columns per stage), filter by form, stage, date or search by name, email or phone.

Each form has its own pipeline with five stages. Move a lead forward by dragging its card on the board or by clicking the stage in the lead's detail panel.

| Pipeline | Stages, in order |
|---|---|
| Reservations | New request → Contacted → Confirmed → Seated → Closed |
| Private events | New inquiry → Contacted → Tour / proposal → Booked → Closed |
| Contact | New → Replied → Follow-up → Resolved → Closed |
| Newsletter | New → Welcomed → Engaged → Subscriber → Unsubscribed |

Use the fourth stage (Seated / Booked / Resolved / Subscriber) for a win; the Dashboard and the weekly summary count those. Use **Closed** for anything that ended without a win (no-show, cancelled, spam).

In the detail panel you can:

- **Reply by email**: opens your email program with the guest's address and a subject already filled in.
- **Call**: dials the guest's number on a phone.
- Read every field the guest filled in, their message and, for events, open the attached file.
- **Add a note** (who wrote it and when is recorded). Notes are internal; the guest never sees them.
- See the full history: when it arrived, which emails were sent, every stage change and note.
- **Delete** (admins only) for spam. This cannot be undone.

### Export

**Export CSV** on the Leads toolbar downloads whatever is currently filtered as a spreadsheet file. Exports are recorded in the audit log. Staff can only export if an admin has given them that permission.

## 5. Adding your team

Only admins see **Team**.

1. Team → **Invite**. Enter the person's email, name and role.
2. They receive an email with a link to set their own password (valid 24 hours). If email is not connected yet, the link is shown to you instead; send it to them privately.
3. Roles:
   - **Admin**: everything, including Team, Settings, Automations, Media and the Audit log, and deleting leads.
   - **Staff**: Dashboard, Leads (view, change stage, add notes) and Analytics. Staff cannot export, delete, invite people, change settings or see the audit log unless you tick those extra permissions on their profile.
4. You can also **hide sections** per person (for example hide Analytics from the host stand), **deactivate** someone who leaves (this signs them out immediately), send a **password reset**, or **sign them out everywhere**.
5. There must always be at least one active admin; the CRM will not let you remove the last one or demote yourself.

## 6. The confirmation emails and who gets notified

Admins only, under **Settings** and **Automations**.

- **Settings → Notification emails**: the addresses that receive every new lead, separated by commas. Below it, per-form routing lets you send, for example, private event inquiries to the events coordinator only.
- **Automations → Auto-replies**: one template per form with a subject and a message. You can turn each one on or off. Words in braces are filled in automatically: `{first_name}`, `{name}`, `{email}`, `{date}`, `{time}`, `{party}`, `{guests}`, `{subject}`, `{business}`, `{phone_number}`, `{for_date}`. Use **Preview** to see the finished email and **Send test** to receive it yourself before saving.
- **Settings → Integrations** also shows whether email, the anti-spam check, Google Analytics and the AI summary are connected, with a **Test connection** button for each. If you ever receive an API key from Smart Marketing or a vendor you can paste it here; it is stored encrypted and only its last 4 characters are ever shown again.

## 7. What the weekly email is

Every Monday at 8:00 AM (New York time) the admins receive "Weekly summary": new leads in the last 7 days, how many are still waiting for a first reply, counts per form with how many were seated / booked / resolved, emails sent and failed, and, if Google Analytics is connected, website visits and top traffic sources. With the Anthropic add-on it also includes three short paragraphs and up to three suggestions written from those numbers; without it you get the numbers only.

In **Automations → Weekly summary** you can change the recipients, switch it off, see when it last ran, and press **Run now** to get one immediately.

## 8. If something looks wrong

| What you see | What to check | Then |
|---|---|---|
| A guest says they submitted a form but there is no lead | Leads → filter "Any time", search their name or email. Check the Dashboard warning area. | If nothing is there, ask the guest which page and roughly when, and send that to Smart Marketing. |
| Leads arrive in the CRM but no notification emails | Dashboard → Email health. Settings → Integrations → Resend → Test connection. Check the spam folder and that the address under Notification emails is right. | If the test fails or says the domain is not verified, contact Smart Marketing. |
| The guest did not receive the confirmation | Automations: is that form's auto-reply switched on? Open the lead: the history says whether the auto-reply was sent or failed and why. | Send the guest a manual reply; forward the error text to Smart Marketing. |
| The form on the website shows "Please complete the verification step" | The anti-spam check is switched on but not finished on the page. | Contact Smart Marketing; this is a configuration step, not something a guest did wrong. |
| Someone cannot sign in | After 5 wrong attempts sign-in is blocked for 15 minutes. Check Team: is the account active? Use Reset password. | If an admin cannot get in either, contact Smart Marketing. |
| The weekly email did not arrive | Automations → Weekly summary: enabled? last run? error? Press Run now. | If Run now fails, contact Smart Marketing with the error shown. |

Contact: Smart Marketing (https://www.smartmarketingg.com). When you write, include the lead's name or ID, the time it happened and a screenshot of any message you saw.

## 9. Things to never do

- **Never share a `#set=` link** (setup, invitation or reset link) with anyone other than the person it was sent to, and never post it in a group chat. Anyone holding it can set that person's password.
- **Never send API keys or passwords by email or text.** Paste keys only into Settings → Integrations, or give them to Smart Marketing through a password manager share.
- **Never delete or edit the database or storage buckets** in the Cloudflare dashboard (items named `fuego-steakhouse`, `fuego-media`, `fuego-private` and their `-preview` copies). Deleting the database deletes every lead and every account.
- **Never change settings in the Cloudflare dashboard** (secrets, variables, DNS, the Worker) without Smart Marketing. One wrong value can stop the forms or the emails.
- Do not sign in to the CRM on a device you do not control with "Keep me signed in" ticked.
- Do not use **Delete** on a lead to "close" it; move it to Closed instead. Delete is for spam only and cannot be undone.
