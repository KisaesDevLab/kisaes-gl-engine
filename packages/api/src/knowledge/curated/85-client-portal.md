## Client Portal

The Client Portal is a separate, mobile-friendly surface where a firm's clients sign in
(magic link or password) to answer questions, upload receipts, and view what the firm has
shared. Firm staff manage it from **Practice → Client Portal**: contacts, per-company
access toggles, and settings. Staff can verify what a client sees with **View as Client**
(preview mode, always read-only).

Access is layered: a feature must be enabled for the tenant (feature flag, super-admin),
and then granted per portal contact per company by the firm (Edit Contact → access
toggles). Everything defaults off except questions and receipt uploads.

### Invitations (how a client first hears about the portal)

Adding a contact emails them an invitation, ticked by default on the Add Contact form
("Email them an invitation now"); untick it to set someone up quietly. The message names
the practice, says what the portal is for, and carries a single-use link good for
**7 days** — unlike the **sign-in link** button on each row, which is the ordinary
15-minute magic link. **Resend invite** (envelope icon) sends it again, for the client who
deleted it or let the link expire; the key icon still sends a quick sign-in link. Both
share the per-contact limit of 5 links/hour with the client's own login page, and both
report honestly: SMTP unset means "logged on the server, not delivered" rather than a
green tick. Sending invalidates any earlier unconsumed link for that contact. Route:
`POST /practice/portal/contacts/:id/invite`; creation takes `sendInvite` and answers with
`{ invite: { sent, viaStub, rateLimited } }`. Added 2026-09-24 — before it, creating a
contact sent NOTHING and clients waited for an email nobody had written.

### Who portal mail says it is from

`{firm_name}` is the managing PRACTICE, resolved from the active `tenant_firm_assignments`
row (`resolveFirmName`), falling back to the tenant name on an appliance install with no
separate firm. It is not `tenants.name`: every client is a tenant, so that read as the
client's own name — a categorize request went out titled "TimberStone LLC needs your help
with 42 transaction(s)" and signed "TimberStone LLC", to TimberStone's own bookkeeper
contact (fixed 2026-09-24). `{company_name}` is the client's company and is correct.

### The same email in two firms

A portal contact belongs to ONE tenant. The same address in two tenancies is two separate
contact rows. Asking for a link at a bare `/portal/login` (no `?firm=`) sends one sign-in
link **per active tenancy** — two emails, each opening that firm's portal; there is no
"pick a firm" screen. With `?firm=<slug>` only that tenancy's link is sent. A session
belongs to one contact, so switching firms means using the other link. The in-portal firm
switcher exists but needs `PORTAL_IDENTITY_LINKING_V1` (env, default OFF) AND the contacts
linked to one identity; linking happens on contact create and on `setPassword`, never on a
plain magic-link login, so contacts created before the flag was turned on stay unlinked
until one of those happens.

### Balances & Activity (banking views)
When the firm grants **Can view bank & card activity**, the client's portal shows a
Balances section: each checking/savings account and credit card with its current **book
balance** (what the books say — not the live bank balance; outstanding checks make them
differ). Credit cards show a positive "balance owed."

Tapping an account opens its activity view — a simplified register: date, description,
category, check number, payment/deposit amount, and running balance. Clients can switch
between last 30 days, last 90 days, and this year, search, and load more. Voided
transactions, memos, and reconciliation details are never shown to clients.

Requires the tenant flag `PORTAL_BANKING_V1` plus the per-contact toggle.

### Fixing a bank login from the portal
When a bank asks for a fresh sign-in (Plaid reports ITEM_LOGIN_REQUIRED, a
pending disconnect, or an error), a client can re-authenticate it themselves
from the portal instead of waiting for a staff-sent repair link. Enable it per
contact per company with **Practice → Client Portal → Contacts → "Can fix bank
logins"** (off by default; it also needs the tenant flag `PORTAL_BANKING_V1`).
The client then sees a "needs you to sign in again" banner on the portal home
and on Balances, plus a **Bank connections** card on Balances listing each
institution with its status and a **Fix sign-in** button. Fixing opens the
bank's own sign-in (Plaid Link update mode) — the client never sees or enters
credentials in MyBooks, and only connections feeding that company's accounts
are shown. When it succeeds the connection is marked healthy, a sync runs, and
whoever set the connection up gets an email. Preview ("View as Client") can see
the card but can never start a fix. OAuth banks (Chase, Capital One) return via
the registered `/connect/oauth-return` URL, which requires PUBLIC_URL to be set.

### Vibe Practice Management peer ("one client portal")

A firm running Vibe Practice Management (Vibe PM, repo Vibe-Time-Billing) can show the
MyBooks client portal INSIDE PM's own client portal: PM renders the screens natively and
fetches data from `POST/GET https://<mybooks>/api/peer/pm/…` with a short-lived JWT it
signs (ES256/RS256, `typ: vibe-pm-peer`, `aud: vibe-mybooks`, ≤ 5 min, single-use `jti`
kept in Redis — fails CLOSED if Redis is down). No SSO, no iframe, no MyBooks login for
the client. Trust root per firm: **Firm → Settings → Vibe Practice Management** card —
issuer (globally unique), PEM public key OR JWKS URL (https, SSRF-guarded), Enable,
"Test a token" (verifies without consuming). Writes are firm_admin (`requireFirmAdmin`,
so on Default Practice = super admin only); staff read. Tables `firm_peers` and
`pm_client_links` (migration 0172).

Client matching is an explicit link table staff maintain on the same page (**Linked
clients**): PM client id → tenant → company → portal contact. PM inherits exactly that
contact's per-company toggles (financials, files, questions, banking, bill pay,
categorize, fix bank logins); tenant feature flags still apply. `GET /portal/context`
returns `features` = flag ∧ grant. The link is re-validated on EVERY request — contact
paused, contact unlinked from the company, company portal paused, tenant detached from
the firm, firm inactive → uniform 404 `PM_LINK_NOT_FOUND`; any token problem → uniform
401 `PEER_TOKEN_INVALID`; a `companyId` that differs from the link → 400
`PEER_COMPANY_MISMATCH`. Staff need `user_tenant_access` on the tenant to link/unlink.

Ops signals: the card shows Last seen and Last error (enum: sig_invalid, unknown_kid,
expired, replay, jwks_fetch_failed, no_link); each accepted token writes one audit row
`portal_peer_access` (action login) under the client tenant with the PM actor email.
The spec PM implements is `docs/vibe-pm-integration.md`. Common questions: "PM says
PEER_TOKEN_INVALID" → issuer mismatch, key rotated, clock skew > 30 s, or the same
token sent twice; "tab missing in PM" → the link is missing/inactive or the feature/grant
is off — check `/links` and the contact's toggles.

### Bill Pay (clients mark bills for payment)
When the firm grants **Can pay bills**, clients see their company's unpaid bills (vendor,
invoice number, due date, overdue age, balance due) and can select bills and tap **Pay
bills**. Each selected bill is paid in full — partial payments aren't available from the
portal.

What happens on confirm:
1. The system posts one bill payment per vendor (multiple bills for the same vendor
   combine into one check) drawn on the bank account the firm configured.
2. The checks land **unnumbered** in the firm's print queue (**Checks → Print Checks**),
   badged "Client requested." Nothing is printed or numbered until firm staff print
   through the normal flow — including signature step-up authentication if signatures
   are configured.
3. The designated staff member (or all owners, if none is set) receives a "Checks ready
   to print" email listing the vendors and amounts with a link to the print queue.

The portal then shows those payments under "Queued for printing" until the firm prints
them. Bills already paid by someone else are skipped safely — marking twice never
double-pays.

Firm setup (all three required before clients can pay bills):
1. Super-admin enables the tenant flag `PORTAL_BILL_PAY_V1`.
2. **Practice → Client Portal → Settings → Client bill pay** — per company, pick the
   checking account payments draw on and who gets the notification email. Without a bank
   account configured, clients see "contact your accountant" instead of the pay button.
3. Edit each contact and turn on **Can pay bills** for the company.

### Document requests — unread client submissions & staff notification
Standing document requests (**Practice → Reminders → Recurring requests**) ask a portal
contact for a document on a schedule. When the contact uploads against a request, it
becomes **submitted** and is **unread** until a staff member marks it reviewed.

Where unread submissions appear:
- **Dashboard** — the "Client portal activity" banner shows "N client submissions to
  review"; clicking it opens Reminders filtered to unread.
- **Clients screen** (View all clients… in the company switcher) — an inbox icon with a
  count next to a client with unread submissions, and a red calendar icon with a count
  when that client has document requests past due.
- **Practice → Reminders** — "Unread submissions" tile, an "N new" badge on the Open
  requests tab, and an "Unread submissions" filter; unread rows carry a **New** badge
  and show the uploaded filename.

Viewing what was sent: click the filename on a submitted row to open the document inline
(PDFs and images render in a viewer with a Download button).

Clearing them: the **Mark reviewed** (open-envelope) row action, or **Mark all reviewed**
on the unread filter. "Mark received" (closing a request by hand) and manually routing a
statement from the receipts inbox count as reviewed. A second upload against an
already-reviewed request makes it unread again.

Staff email on submission: in the rule editor, **Email staff when the client submits**
lists active staff users with access to the client; everyone checked is emailed the
moment the contact uploads (client, request, period, filename, link to the grid). Editing
the list applies to requests already outstanding. Needs SMTP configured; the unread
tracking works regardless. Feature flag: `RECURRING_DOC_REQUESTS_V1`.

### Sending bills from the portal (Bill Capture)
Flag `AP_BILL_CAPTURE_V1` plus the per-contact **Can upload bills** toggle (Practice → Client
Portal). The client sees a **Send us bills** tile → `/portal/bill-upload`: drag-and-drop PDF/JPG/PNG/
WEBP/HEIC (10 MB each, up to 10 per drop), then a list of their own uploads with Received /
Being processed / Entered / Reviewed. No amounts or accounting detail are shown. Uploads land in
the company's **Payables → Bill Capture** queue for staff; one email per upload batch goes to the
company's bill-pay notify user, else the owners. Preview ("View as Client") cannot upload.

## Clients suggesting categories ("What was this?")

Feature flags: `PORTAL_CATEGORIZE_V1` (the client half) and `UNCATEGORIZED_REVIEW_V1`
(the staff review queue). They are SEPARATE switches and both default off. On top of
the tenant flag, each portal contact needs **Can suggest categories** ticked on
Practice → Client Portal. That per-contact tick is the step people miss: with the flag
on and the tick off, the client sees nothing at all. It defaults to false and is reset
to false if a contact's company assignments are re-saved without it.

What the client sees: a **What was this?** page listing only activity nobody could
classify — bank lines the categorizer could not place, and amounts already posted to
suspense. Rows the software categorized confidently are deliberately excluded. Each row
shows the cleaned name and, under it, **On your statement:** the bank's own wording
(`bank_feed_items.original_description`, also for a suspense amount that posted from a
feed line) — a deliberate policy change on 2026-09-24; the AI guess, confidence and
reasoning remain firm-only. The picker offers income and expense accounts by name only: no balances, no account
numbers, no balance-sheet accounts. Two extra answers exist, **Personal, not business**
and **I am not sure** (which asks for a note).

Nothing a client does here posts. Answers arrive as suggestions on Practice →
Uncategorized → Client suggested, where staff approve, override or send them back. That
tab also lists suggestions the company's own team members sent from Banking →
Uncategorized (badge **Team member** vs **Client**); both share the same queue and the
same one-live-answer-per-row rule.

The payee (2026-09-24, migration 0179): every row also asks **Who was it paid to or
from?** — a select of EVERY active contact of the tenant (vendors, customers, both; all
types on every row, user decision) served by `GET /api/portal/categorize/payees` as
`{id,label,kind}` only, plus **Someone not in this list…** which reveals a 120-char name
box. A payee on its own is a complete answer: it goes up as "I am not sure" carrying the
payee, and "not sure" no longer demands a note when a payee is given. Stored as
`suggested_contact_id` (FK, SET NULL if the contact is merged/deleted) plus
`suggested_contact_label` (the name as shown or typed — always set). The write path
allowlists `contactId` against the same payee list (`invalid_payee`). Staff see a
**Payee** column on Client suggested; a typed name is badged **Not in contacts** and is
resolved with the override payee picker (its quick-add creates the contact). Approving
applies the payee: a bank line via categorize's contactId, a suspense amount inside the
SAME bulk update as the move out of suspense (`clearSuspense(..., { payeeContactId })`),
recorded as `resolved_contact_id`; an override payee marks the resolution `overridden`.
A payee-only answer still cannot be approved without a category (`no_category` →
override with one). Team-member suggest accepts the same two fields.

The note: every row has a note box, always available and NOT gated on picking a
category — a client who cannot name the account can usually still say what the
payment was for. A note on its own is a complete answer and is submitted as
"I am not sure" carrying the note. Choosing "I am not sure" with no note is
refused (server reason `note_required`) and the portal says so rather than
reporting "sent 0 answers". Rows the server turns down keep what the client
typed and explain why. Staff read the note in its own **Client note** column on
Practice → Uncategorized → Client suggested, shown in full beside what the
client picked. A returning client sees its own note read back on rows still
waiting.

Attaching a receipt: each row has **Attach a photo or receipt** — images and PDFs, 10 MB
per file, up to 10 files per transaction. It uploads immediately rather than waiting for
"Send to my bookkeeper", because a client often has the photo before it has the answer.
The file is stored as an ordinary attachment on the transaction or bank line, so it shows
up on the paperclip staff already use on Practice → Uncategorized; there is no separate
client inbox. A client can list and remove only its own uploads — files the firm attached
to the same row are never shown in the portal, not even by filename.

Getting into the screen: the portal has no navigation bar, so the way in is the portal
dashboard. When rows are waiting, the dashboard leads with a full-width banner above the
counters — "N transactions need your input" — because the quiet tile it replaced read as
optional and clients skipped it (changed 2026-09-24). When the queue is empty the banner
disappears and the plain **Categorize transactions** card takes over, so the screen stays
reachable. Both need the flag and the per-contact tick.

Asking the client to come and look ("Ask the client for help"): clients do not check the
portal unprompted, so Practice → Uncategorized → **In suspense** has an **Ask the client
for help** button. It emails, and optionally texts, the portal contacts who have **Can
suggest categories** ticked for that company — nobody else, because a contact without the
tick would log in and find nothing. The message says how many transactions are waiting,
carries the portal login link (`/portal/login?firm=<slug>`), and can carry a personal
note from staff. Before sending, the screen states what the client will actually find:
the portal flag off (refused, HTTP 409 `PORTAL_CATEGORIZE_OFF`), nobody ticked, or an
empty portal queue (refused with 409 `PORTAL_QUEUE_EMPTY` unless staff tick "Send anyway"
— usually the rows sit in an account that is not the `system_tag='suspense'` account).
Texting requires the firm's `sms_outbound_enabled` switch AND a system SMS provider;
otherwise the option is greyed out with the reason. STOP opt-outs (reminder_suppressions)
are always honoured; there is no weekly cap because a person presses the button, and the
list shows when each contact was last asked and last seen in the portal. Every attempt is
a `reminder_sends` row (question_id = the company id, schedule_id null) so opens/clicks
show on the reminders dashboard. Wording is customisable under Practice → Reminders →
Templates, trigger **Ask client to categorize** (`categorize_request`), variables
`{first_name} {firm_name} {company_name} {count} {portal_link} {note}`.
API: `GET/POST /api/v1/practice/uncategorized/help-request[/recipients]`.

Reminding them ("Send reminder", 2026-09-24): the same toolbar has a **Send reminder**
button beside it. Same route, same recipients, same `reminder_sends` tracking and STOP
rules — `reminder: true` on the POST changes two things. The wording is the reminder
wording ("Reminder: N transaction(s) still need your answer"), customisable separately
under trigger **Remind client to categorize** (`categorize_reminder`) with the same
variables. And the default selection is only the contacts who were asked and have not
answered since: the recipients response carries `lastAnsweredAt` (latest
`client_category_suggestions.submitted_at` for that contact and company, any status)
next to `lastAskedAt`, and those rows are badged **No answer since you asked**. If
nobody has been asked yet the screen says so and ticks everyone, so the button is never
a dead end. Reminders are manual — one person pressing one button — OR automatic, below.

Automating it (2026-09-24, migration 0180): a **reminder_schedules** row with
`trigger_type = 'categorize_reminder'` (Practice → Reminders → Schedules → trigger
**Uncategorized transactions**) turns the button into a cadence. `cadenceDays` are
day-offsets from the FIRST message of a spell: `[3,7,14]` opens the chase, then chases
again 3, 7 and 14 days later, then stops. A "spell" runs from the client's last answer
(or from the first message if they have never answered) until they answer again, which is
what stops a new uncategorized row restarting the cadence at day one and gives someone who
just sent ten answers a few days of quiet before the next nudge about the rest. It sends
through the same `sendHelpRequest` with `reminder: true` plus the schedule id, so an
automated nudge and a staff click are the same message with the same tracking; `step` (1 =
the opener) drives the escalating channel strategy. It stops for: an empty portal queue,
`PORTAL_CATEGORIZE_V1` off, quiet hours, the schedule's per-contact `maxPerWeek` (counted
across ALL portal mail, not just this trigger), STOP opt-outs, and a 20-hour floor between
messages whatever the cadence says. Runs on the existing half-hourly portal-reminder tick
under advisory lock `portal-categorize-reminder`
(`dispatchCategorizeReminders`). Templates: trigger `categorize_reminder`.
