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

Clearing them: the **Mark reviewed** (open-envelope) row action, or **Mark all reviewed**
on the unread filter. "Mark received" (closing a request by hand) and manually routing a
statement from the receipts inbox count as reviewed. A second upload against an
already-reviewed request makes it unread again.

Staff email on submission: in the rule editor, **Email staff when the client submits**
lists active staff users with access to the client; everyone checked is emailed the
moment the contact uploads (client, request, period, filename, link to the grid). Editing
the list applies to requests already outstanding. Needs SMTP configured; the unread
tracking works regardless. Feature flag: `RECURRING_DOC_REQUESTS_V1`.
