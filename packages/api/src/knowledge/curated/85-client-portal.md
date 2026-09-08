## Client Portal

The Client Portal is a separate, mobile-friendly surface where a firm's clients sign in
(magic link or password) to answer questions, upload receipts, and view what the firm has
shared. Firm staff manage it from **Practice → Client Portal**: contacts, per-company
access toggles, and settings. Staff can verify what a client sees with **View as Client**
(preview mode, always read-only).

Access is layered: a feature must be enabled for the tenant (feature flag, super-admin),
and then granted per portal contact per company by the firm (Edit Contact → access
toggles). Everything defaults off except questions and receipt uploads.

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

## Clients suggesting categories ("What was this?")

Feature flags: `PORTAL_CATEGORIZE_V1` (the client half) and `UNCATEGORIZED_REVIEW_V1`
(the staff review queue). They are SEPARATE switches and both default off. On top of
the tenant flag, each portal contact needs **Can suggest categories** ticked on
Practice → Client Portal. That per-contact tick is the step people miss: with the flag
on and the tick off, the client sees nothing at all. It defaults to false and is reset
to false if a contact's company assignments are re-saved without it.

What the client sees: a **What was this?** page listing only activity nobody could
classify — bank lines the categorizer could not place, and amounts already posted to
suspense. Rows the software categorized confidently are deliberately excluded. The
picker offers income and expense accounts by name only: no balances, no account
numbers, no balance-sheet accounts. Two extra answers exist, **Personal, not business**
and **I am not sure** (which asks for a note).

Nothing a client does here posts. Answers arrive as suggestions on Practice →
Uncategorized → Client suggested, where staff approve, override or send them back.

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

Getting into the screen: the portal has no navigation bar, so the way in is the
**Categorize transactions** tile on the portal dashboard. It appears whenever the flag
and the per-contact tick are both on, including when the queue is empty.

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
