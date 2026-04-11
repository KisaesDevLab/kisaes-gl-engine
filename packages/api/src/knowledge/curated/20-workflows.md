## Major Workflows

### Bill → Payment Workflow
1. **Enter Bill** — record the vendor invoice with line items, terms, due date.
2. **Pay Bills** — when the bill is due, select it for payment.
3. **Apply Vendor Credits** (optional) — reduce the cash payment by any credits
   you have from this vendor.
4. **Pay** — choose method (check, ACH, etc.). Vibe MyBooks creates the bill payment
   transaction and updates the bill's status.
5. **Print Checks** (if paying by check) — go to **Print Checks →** to print
   queued checks in a batch.

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
1. **Import** — connect a bank via Plaid or upload a CSV statement.
2. **Categorize** — for each pending feed item, pick the expense or income
   account, optionally a contact, and confirm. The assistant turns it into a
   posted transaction.
3. **Match** — if a feed item corresponds to an existing transaction (e.g., a
   bill payment you already entered), use Match instead of Categorize so you
   don't double-count.
4. **Bank Rules** — automate categorization for recurring transactions by
   creating rules that match by description / amount.

### Reconciliation
1. **Start Reconciliation** — pick the bank account and enter the statement
   ending balance and date.
2. **Mark Cleared** — tick off each transaction that appears on the statement.
3. **Difference must be $0.00** — if it's not, you have either uncleared
   transactions, cleared something incorrectly, or there's data missing.
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
   edits to the closed period.
4. Vibe MyBooks automatically rolls revenue/expense balances into Retained Earnings
   each fiscal year — there are no manual closing entries.
