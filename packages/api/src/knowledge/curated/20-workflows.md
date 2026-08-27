## Major Workflows

### Bill → Payment Workflow
1. **Enter Bill** — record the vendor invoice with line items, terms, due date.
2. **Pay Bills** — when the bill is due, select it for payment.
3. **Apply Vendor Credits** (optional) — reduce the cash payment by any credits
   you have from this vendor.
4. **Pay** — choose method (check, ACH, etc.). Vibe MyBooks creates the bill payment
   transaction and updates the bill's status. Paying by check also shows a
   **Memo on check** field: leave it blank and each check's memo line prints the
   vendor invoice numbers it covers (our bill number where the vendor gave none),
   or type your own — an account number, say — to use instead.
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
