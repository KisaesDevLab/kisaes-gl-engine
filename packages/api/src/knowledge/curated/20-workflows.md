## Major Workflows

### Bill → Payment Workflow
1. **Enter Bill** — record the vendor invoice with line items, terms, due date.
   Or use **Payables → Bill Capture** to upload a stack of bills and let the AI pre-fill each
   one for review (see AI Features).
2. **Pay Bills** — when the bill is due, select it for payment.
3. **Apply Vendor Credits** (optional) — reduce the cash payment by any credits
   you have from this vendor.
4. **Pay** — choose method (check, ACH, etc.). Vibe MyBooks creates the bill payment
   transaction and updates the bill's status. Paying by check also shows a
   **Memo on check** field: leave it blank and each check's memo line prints the
   vendor invoice numbers it covers (our bill number where the vendor gave none),
   or type your own — an account number, say — to use instead. Paying any other
   way (ACH, credit card, cash, other) shows an optional **Ref #** field instead —
   an ACH trace or confirmation number. The method and Ref # are saved on the
   payment and show on the transaction and its **Transaction Report**.
5. **Print Checks** (if paying by check) — go to **Print Checks →** to print
   queued checks in a batch. Click a queued check's Memo cell to retype its memo
   before it prints; after printing, reprint the batch to edit it. Hand-written
   checks skip the queue, so their memo is fixed at the moment you record them.

The accounting impact:
- Bill posts: `DR Expense lines, CR Accounts Payable (total)`
- Payment posts: `DR Accounts Payable, CR Bank`

### Customer Invoice → Payment Workflow
1. **New Invoice** — record what the customer owes, with line items, taxes, terms.
2. **Send Invoice** — email it via the Send button on the invoice detail page.
3. **Receive Payment** — when the customer pays, record the payment and apply it
   to one or more open invoices.
4. **Bank Deposit** — when you take the money to the bank, create a deposit that
   moves the funds out of Payments Clearing into the bank account.

### Bank Feed Categorization
1. **Import** — connect a bank via Plaid, upload a CSV statement, or send
   the client a **bank connection invite** (Banking → Invite client, gated
   by the BANK_CONNECT_INVITES_V1 flag): they get an emailed/texted link
   (/connect/…, valid 7 days, works for multiple banks) that runs Plaid
   Link with no MyBooks login; the resulting connection is attributed to
   the inviting staff user, who is emailed to map the new accounts.
   When a connected bank's login later breaks (ITEM_LOGIN_REQUIRED), a
   "needs attention" banner appears on Bank Connections AND the Bank Feed
   with two repair paths: **Update login / Fix Now** (staff re-authenticate
   in-app via Plaid update mode — nothing is disconnected) and **Email fix
   link** (a repair invite: the client of record gets a public
   fix-your-bank-login link, valid 7 days). The sync worker also
   auto-sends the fix link to client-connected banks (max one per 3 days,
   3 per 30 days per connection; kill switch: Admin → Plaid → "Auto-send
   fix your bank login links").
   The Bank Feed opens with **Hide processed** ticked by default — only
   pending/assigned items show; un-tick it (or use a status button) to see
   matched, categorized, or excluded rows.
2. **Categorize** — for each pending feed item, pick the expense or income
   account, optionally a contact, and confirm. The assistant turns it into a
   posted transaction.
3. **Match** — if a feed item corresponds to an existing transaction (e.g., a
   bill payment you already entered), use Match instead of Categorize so you
   don't double-count.
4. **Bank Rules** — automate categorization for recurring transactions by
   creating rules that match by description / amount.

### Reconciliation
1. **Start Reconciliation** — three ways:
   - **Manually** — pick the bank account and enter the statement ending
     balance and date.
   - **Import statement (PDF)** — upload the bank statement PDF/image; the
     parsed lines power the Statement Match Engine, which auto-clears and
     suggests matches against your books.
   - **Import bank file (QFX/OFX/QBO)** — upload the file downloaded from
     your bank's website (Quicken/QuickBooks/OFX format). Parsed instantly
     (no OCR), it appears under Statements on File ready to reconcile with
     the same match engine. First import of a new account number asks which
     GL account it belongs to and remembers the answer.
2. **Mark Cleared** — tick off each transaction that appears on the statement
   (or let the match engine do it from an imported statement).
3. **Difference must be $0.00** — if it's not, you have either uncleared
   transactions, cleared something incorrectly, or there's data missing.
   **Refresh transactions** pulls newly entered transactions onto the
   worksheet and removes ones voided since it was opened. Uncleared rows
   that mirror an already-cleared transaction (same amount + same check
   number or nearby date) get a **Likely duplicate** badge, and any
   uncleared row can be voided directly from the worksheet (reason
   pre-filled, reversing entries posted, totals recalculated) — duplicates
   are never voided automatically.
4. **Complete** — locks in the cleared state for that statement.

If the difference is off by a small amount like $0.01, it's almost always a
rounding mismatch on a journal entry. Common causes: tax calculation rounding,
foreign currency conversion, or a bill paid for slightly more than its total.

### Vendor Credit Workflow
1. **Record Vendor Credit** — vendor sends a credit memo (refund, return).
2. **Pay Bills** — when paying any future bill from that vendor, the credit
   appears as available to apply against the cash portion.
3. **Apply** — tick the credit, choose how much to apply against which bill.
4. The bill's status updates to reflect the credit + any cash paid.

### Period Close
1. **Reconcile** every bank account through the period end.
2. **Run reports** (P&L, Balance Sheet, Trial Balance) and review for anomalies.
3. **Set the Lock Date** under **Settings → Closing Date** to prevent further
   edits to the closed period. The lock date is per-company and blocks posting,
   editing, and voiding transactions — including bill payments — dated on or
   before it.
4. Vibe MyBooks automatically rolls revenue/expense balances into Retained Earnings
   each fiscal year — there are no manual closing entries.

### Filling check payees and categories from a statement
Bank feeds label a check with whatever the bank prints (often the account nickname, or
just "CHECK 3607"), while a parsed statement reads the *pay to the order of* name off the
check image. **Bank Feed → Fill Payees from Statements** joins the two.

What it does, for unposted check rows that have a check number but no payee:
1. Matches them to `bank_statement_lines` by **check number, confirmed by amount within a
   cent** (debit side only, so a deposit quoting a check number is never touched).
2. Writes the payee and links the vendor contact, creating the vendor when it is new.
3. Suggests the **expense account** when every prior posted check to that payee used the
   same one, requiring at least two prior checks.

Nothing posts; rows stay pending for review. The button previews first and asks for
confirmation, because applying can create vendor contacts, and statements sometimes read
one vendor two ways ("J & A Janitorial" vs "J&A Janitorial, LLC") which would become two
contacts.

Deliberate limits: a payee coded to several accounts in the past gets a payee and NO
category rather than a guess; months with no imported statement are untouched.

This is distinct from the Reconciliation page's check-payee backfill, which repairs
already-POSTED check transactions. Categorization also now consults payee history
generally: once a feed row has a payee, its category can be suggested from how that payee
was coded before, which description matching could never do for checks.

### Team members suggesting categories (Banking → Uncategorized)
Company users who are NOT firm members (owner, accountant, bookkeeper with the banking
permission; not readonly) get **Banking → Uncategorized** (`/banking/uncategorized`) when
the tenant flag `UNCATEGORIZED_REVIEW_V1` is on. Firm members and super admins are
redirected to Practice → Uncategorized, which is now firm-members-only. The team view
shows only amounts in suspense and is SUGGEST-ONLY: a short income/expense category list
(same sanitized list as the client portal) plus *Personal / not business* and *Not sure*
(note required), a note box, and one **Send N answers** button per batch (one reviewer
email per batch). Answers land as `client_category_suggestions` rows with
`submitted_by_user_id` set; the row stays marked "Sent · awaiting review" with a Withdraw
for the author only; a team member can never overwrite someone else's pending answer
(`already_answered`). Reviewers: staff of the firm ACTIVELY managing the tenant (any firm
role) approve on Practice → Uncategorized → Client suggested (Team member badge); on
self-managed books the OWNER gets a Suggested tab in Banking → Uncategorized. The API
decides via `GET /practice/uncategorized/mode` (`{mode, managedByFirm, firmName,
canReview}`); approve/reject/clear/post-to-suspense answer 403 `SUGGEST_ONLY_MODE` to
non-reviewers. Team endpoints: `GET /team/categories`, `POST /team/suggest`,
`DELETE /team/suggest/:id`, `GET /in-suspense?includeSuggestions=true`.

### Correcting a misread amount on a statement import
In the **Import Bank Statement** review table every row's Amount and debit/credit direction
are editable (press Enter or click away to save). The correction is persisted onto the
statement's processing record, so both the bank-feed items and the stored statement lines
carry it, and the Golden-Rule banner + per-row "off by" badges are re-checked at once
(edited rows are marked). After a statement is saved, an unmatched line on its
reconciliation has **Fix amount** (negative = money out); re-run **Match statement**
afterwards. Matched lines must be unmatched first.

### Write Check requires a vendor contact
On **Write Check**, *Pay to the Order of* must be a vendor contact (type to search, or add
one from the list). Typing a payee name or address without selecting a vendor shows an
inline warning and Save is blocked until a vendor is picked — the contact links the check to
the vendor's history and 1099 totals.

### Quick Add Account
Firm staff (members of the firm assigned to the company, any role, plus super admins)
get an "Add …" row in every account/category dropdown. It opens **Quick Add Account**
(name prefilled from what was typed, optional number, account type, detail type). The type
list is limited to what that dropdown accepts, e.g. only Expense on an expense line, and the
new account is selected immediately. Only creating is opened up this way: editing, merging
or deleting accounts still needs the Chart of Accounts permission.

### Quick Add Contact → More details
Every contact picker's "Add …" row opens **Quick Add Contact** (type, display name,
company, email, phone). The type starts as **Vendor**, except on customer-only screens
(invoices, receive payment, cash sales), which start as Customer. A **More details** toggle (collapsed by default) adds the
mailing/billing address, for customers a shipping address with "Same as billing" ticked by
default, and for vendors the **Default Expense Category** and **Default Tag**. Sections
follow the chosen contact type; vendor defaults are never sent for a plain customer. The
new contact is selected in the field that opened the window, so Write Check immediately
fills the printed address and the first expense line from what was just entered.

### Re-reading check images when payees came back blank
Statement parsing reads the payee off each check image with a vision reader. When that
reader is busy or briefly down during a parse, EVERY check comes back blank even though
the images extracted fine, and the statement lands with zero payees.

**Import Bank Statement → Re-read check images** re-runs only that pass against the PDF
already on file. It does not re-parse or re-import anything and creates nothing, so it is
safe to repeat and safe on an already-saved statement. Newly read payees fill into the
review rows immediately; a payee the user typed is never overwritten. When the statement
has already been saved, its stored statement lines are updated too, which is what "Fill
Payees from Statements" on the Bank Feed reads.

Reading the outcome:
- "N payees read from M check images" — worked.
- "Found M check images but could not read a payee from any" — reader busy, retry shortly.
- "No check images found in this PDF" — re-running will never help; either there are no
  check images, or the bank printed several checks onto one full-page scan (the extractor
  keeps images roughly 220px+ wide, 80-1400px tall, aspect 1.4-3.8). Type those by hand.

Distinct from **Re-process** (re-runs the whole extraction; refused once a statement is
saved, to avoid duplicate imports) and from the Reconciliation page's tenant-wide
**Backfill check payees** with its optional re-scan of every stored statement.

## Uncategorized: setting a category one row at a time

Practice → Uncategorized (flag `UNCATEGORIZED_REVIEW_V1`), on both the **Not
posted** and **In suspense** tabs. Each row has a **Category** column using the
same account picker as the transaction forms.

Picking an account does NOT post. The row shows an amber marker and a **Save**
button, and a banner says nothing is committed yet. Pressing Save on that row
posts it and the row leaves the list. The deliberate extra step exists because
a row vanishing the moment a dropdown closed reads as an accidental posting.

If the ledger refuses the move — closed period, voided entry, adjusting entry,
or a bank line someone else already handled — the row KEEPS the pick and the
message says why, rather than clearing the picker and hiding the problem.

The bulk **Set category** action above the table still works the old way: tick
rows, pick one account, apply to all of them.

Both tabs also show a **Ref** column (check number, falling back to the entry
number) and a **Payee** column.
