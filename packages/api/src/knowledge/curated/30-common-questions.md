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

### "How do I set up 2FA?"
Go to **Settings → Security →** and choose your preferred method (Authenticator App,
Email, or SMS). Follow the setup steps — you'll be given recovery codes to save in a
safe place. You can enable multiple methods and choose which to use at login.

### "I lost my authenticator app — how do I log in?"
Use one of your recovery codes at the 2FA prompt. Each code works once. After logging
in, go to **Settings → Security →** to reconfigure your authenticator. If you've used
all your recovery codes, contact your administrator.

### "How do I import lots of transactions at once?"
Use **Batch Entry →** in the Transactions menu. Pick the transaction type, then paste
from a spreadsheet or import a CSV file. You can enter expenses, deposits, invoices,
bills, journal entries, and more in bulk.

### "How do I set up a recurring bill?"
Enter the bill normally, then on the bill detail page click **Make Recurring**. Choose
frequency (monthly, weekly, etc.), mode (auto-post or reminder), and start date. The
system will create the bill automatically on schedule.

### "How do I back up my data?"
Go to **Settings → Backup & Restore →** and click **Create Encrypted Backup**. Set a
strong passphrase (minimum 12 characters). The backup downloads as a `.vmb` file. Store
it somewhere safe — if you forget the passphrase, the backup cannot be recovered.

### "How do I switch between companies?"
Click the company name at the top of the sidebar. A dropdown shows all your companies —
click one to switch. Your data and reports will update to reflect the selected company.

### "How do I connect my bank account?"
Go to **Banking → Bank Connections →** and click **Connect Bank**. If Plaid is
configured by your administrator, you can search for your bank and log in securely.
Otherwise, you can import bank statements manually as CSV files.

### "What file types can I attach to transactions?"
Any file type is supported. Common attachments are receipt photos, invoice PDFs,
contracts, and supporting documents. Upload via the paperclip icon on any transaction,
invoice, or bill.

### "How does AI categorization work?"
When bank feed items are imported, AI can automatically suggest expense or income
categories. The suggestion includes a confidence score. You review and accept or change
the category in the Bank Feed. An administrator must enable AI under
**Admin → AI Processing →**.
