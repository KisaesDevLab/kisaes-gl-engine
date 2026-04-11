## Common Questions

### "How is the due date calculated on a bill?"
The due date defaults to bill date + payment terms days. For Net 30, the due
date is 30 days after the bill date. You can override it manually if the vendor
gave you a different due date. Custom terms let you specify any number of days.

### "Why can't I save this bill?"
Common causes:
- Vendor not selected (required)
- Bill date is missing or empty
- Bill date is on or before the lock date — open **Settings → Closing Date** to check
- Total is $0 — at least one expense line with a positive amount is required
- An expense line has an amount but no account picked

### "Why is my AP balance so high?"
Your Accounts Payable balance is the sum of all unpaid bills. Open the
**AP Aging Summary →** report to see the breakdown by vendor and how long each
bill has been outstanding. If the number looks wrong, look for bills that should
have been paid but weren't, or bills entered with the wrong total.

### "What's the difference between an Expense and a Check?"
A check is a special kind of expense that has a check number, payee name, and
optionally lives in a print queue. Internally both post the same journal entry
(`DR Expense / CR Bank`). Use **New Check** when you specifically need a check
number; use **New Expense** for everything else (debit card swipes, ACH
withdrawals, cash payments).

### "I voided a bill but the journal entries are still there"
That's normal and correct. Voiding never deletes journal lines — instead it
posts a reversing entry that cancels out the original. This keeps the audit
trail intact. The bill is marked void and won't show up in reports.

### "How do I edit a paid bill?"
You can change the expense line allocation (which accounts the money was charged
to, descriptions, splits) on a bill that has payments applied. The total,
vendor, and bill date are locked because changing them would invalidate the
existing payment applications. Open the bill, click **Edit Lines**, reallocate
between accounts so the total stays the same, and save.

### "Where do I see what a customer owes me?"
Open the **AR Aging Summary →** report for an overview, or look at a specific
customer's contact page for their balance and open invoices.

### "How do I write off a bad debt?"
Create a Journal Entry that debits a "Bad Debt Expense" account and credits the
customer's Accounts Receivable balance. Then go to the customer's open invoice
and use Receive Payment with the journal entry as the source. Consult your
accountant for the correct treatment in your jurisdiction.
