## Common Questions

### "Is there a faster way to get to Enter Expense / Write Check / Pay Bills?"
Yes — the Dashboard has a **Quick Actions** row of shortcut cards: Enter Expense,
Write Check, Enter Deposit, Transfer Funds, Enter Bill, Pay Bills, Print Checks,
Bank Feed, Create Invoice, and Receive Payment. Only the shortcuts your permissions
allow are shown. The Cash Position panel on the Dashboard is also clickable — each
bank or credit-card line opens that account's register.

### "Can I type a calculation into an amount field, like 145.15-50?"
Yes. Every amount and number field works like a calculator: type the math and
press Enter, Tab or click away, and the field shows the result (145.15-50 →
95.15). It supports + - * / (also x, ×, ÷), parentheses and %. Percent works
like a calculator: adding or subtracting a percent takes that percent OF the
amount before it (200+15% → 230.00, 200-15% → 170.00, (100+50)+10% → 165.00);
with * or / or on its own, % just means "divide by 100" (200*15% → 30.00,
200/50% → 400.00, 15% → 0.15). The "percent of" rule applies only when the
percent is the whole term being added/subtracted: 200+10*15% → 201.50 and
200+(15%) → 200.15. $ signs, thousands commas and a leading = are ignored. A
"= result" preview shows while you type. Money rounds to the cent. Enter only
works out the math — it does not save the form; press Enter or the save
shortcut again. Invalid math (a typo, dividing by zero) turns the field red and
nothing is saved from it. Debit/credit/payment amounts can't go negative.
Number-as-label fields (years, check numbers, ports, day of month) don't take math.

### "After I pick an account with Enter, where does the cursor go?"
To the next logical field: in a Journal Entry or AJE it jumps to that line's
Debit; in Expense, Write Check, Enter Bill and Deposit lines it jumps to the
Amount; in Transfer it goes From → To → Amount. Payee and other search
dropdowns work the same way. Mouse picks and Tab behave as before.

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
That's normal and correct. Voiding never deletes journal lines — instead,
reversing journal lines are stored on the voided transaction itself, so the
General Ledger keeps the complete audit record (the original lines plus their
reversals net to zero). The document view is unchanged; the bill is marked void
and won't affect report totals. Voiding a transaction dated on or before the
company's lock date is blocked.

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
bills, journal entries, and more in bulk. For migrating from another system (or a
spreadsheet), use **Bulk Import →** instead: it imports a chart of accounts, contacts,
a trial balance, or GL transactions from **Generic Excel templates** (with a
**Download template** button), **Accounting Power**, **QuickBooks Online**, or
**QuickBooks Desktop**, with a validation preview before anything is posted.

### "I posted transactions to the wrong account — how do I move them in bulk?"
On the **Transactions** list, filter by the account they're currently in (or drill
into it from the Balance Sheet). Tick the transactions, then use **Move to Account**
in the bulk toolbar to re-point that account's line to the correct account — e.g.
from a clearing account to a loan account. Splits are safe (only the source side
moves); void, locked-period, and reconciled-cleared lines are skipped and reported;
A/R and A/P can't be bulk-moved. The bulk toolbar also offers **Set Category**,
**Set Payee**, and **Set Tag**.

### "How do I see more than 50 transactions per page?"
Use the **Show** dropdown next to the pager at the bottom of the Transactions list:
50, 100, 250, 500, or **All** (loads the entire filtered set). The choice is
remembered per company.

### "Can I export or print the Transactions list?"
Yes. On the **Transactions** page, set the filters, search, date range, and sort
you want, then click **CSV** (downloads a spreadsheet) or **Print / PDF** (opens a
printable landscape PDF in a new tab). Both export **every matching transaction
across all pages**, not just the visible page, one row per transaction in the
General Ledger layout: Date, Type, Ref #, Name, Description, Account / Category,
Tag, Debit, Credit, and a Total row. When the list is filtered by an account, Debit /
Credit are that account's side (register view); otherwise they are the amounts
posted to the category (expenses as debits, income as credits), multi-category
transactions show "Split", transfers and payments with no category show their
amount in both columns, and void transactions show 0.00. Tag lists the tags on
the transaction's lines (semicolon-separated; blank when untagged). The CSV puts
Tag after Credit and adds a Status column. The PDF header shows the company, date range, filters applied,
the printed date/time, and page numbers. Exports cap at 50,000 rows (CSV) and
10,000 (PDF) with an "Export truncated" note — narrow the filters to get the rest.
Each export is recorded in the audit log (filters and row count only).

### "How do I sort or filter a table by column?"

Click any column header to sort by it (click again to reverse). Every list —
Transactions, Bank Feed, Contacts, Items, Chart of Accounts, Bills, Invoices,
Vendor Credits, Print Checks, statement imports, recurring schedules, the
receipts inbox, document requests, portal questions, the close-review manual
queue, AJEs, daily sales, payroll history, every report table and the admin
Tenants/Users lists — works the same way. Lists that page through the server
sort the whole set (page 2 continues the order), not just the loaded page.
The small ▾ beside a header opens a filter popover: Sort A–Z / Z–A, then tick
the values to keep and Apply (Clear removes it). Where the toolbar already has
a matching dropdown (Status, Type…), the popover and the dropdown are one
filter: one ticked value selects it in the dropdown; several read as "All".
The sort and filters are remembered for the browser tab, and any change
returns to page 1.

### "How do I see more rows in other lists (bills, receipts, admin tables)?"
Nearly every list in the app — bills, vendor credits, statement imports,
reconciliation statements, daily sales, recurring schedules, the attachment
library, practice document requests, portal questions, the receipts inbox, and
the admin tables (tenants, users, Plaid webhook log, MCP log, backup history) —
has the same pager with a **Show** rows-per-page dropdown at the bottom. Older
rows are never hidden anymore; page through with **Prev/Next** or raise the page
size. Close-review buckets and findings use a **Load more** button instead.

### "How do I tag, rename, or copy a Journal Entry or Daily Sales template?"
Open the template (Transactions → Journal Templates, or Daily Sales → Templates).
**Default tag** at the top is applied to every posted line that has no tag of its
own. The **Tag** column fixes a tag on a single line, and that line tag wins over
the entry's tag. When entering a journal or a day's sales, the **Tag** field starts
at the template default and can be changed for that entry. To rename a template,
edit **Template name** and click **Save template**. **Duplicate** copies the saved
template (lines, accounts, tags, memo) under a new name you choose.

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

### "How do I give my accountant access to my books?"
Go to **Settings → Team →** and click **Invite accountant** on the **Your accountant** card.
Enter their email; they get a link and an 8-character code valid for 14 days. When they
accept, your company is linked to their firm and they get Accountant access (their firm's
admins get access too). You can resend or revoke the invitation from the same card. They
need a MyBooks account that belongs to an accounting firm — if they don't have one, their
firm admin adds them first.

### "Can my firm staff manage a client's Team page or settings without being the owner?"
Yes. A firm admin opens **Firm → Staff → Access rights** for the staff member and turns on
the right they need — *Team management*, *Integrations & payments*, *Check signatures*, or
*Screen share admin*. It applies on client companies the firm manages and that the member
already has access to (grant access first under **Tenant access**). *Tenant operations* and
*User support* additionally open Admin → Tenants / Admin → Users limited to the firm's own
clients. Read-only firm members can hold only *Tax Estimator: view taxpayers*, and on the
Default Practice firm only a super admin can change rights.

### "Why can't my staff member see a taxpayer in the Tax Estimator?"
Since Q54, client access alone does not show Tax Estimator taxpayers. A firm admin either
turns on **Tax Estimator: view taxpayers** for them (**Firm → Staff → Access rights**; they
then see taxpayers without a "Who can see this taxpayer" list that are linked to clients they
can access) or adds them to the taxpayer's "Who can see this taxpayer" list. A taxpayer with a
list is visible only to the people on it and super admins — firm admins included.

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

### "A screen isn't showing a change I just made (or someone else made). How do I refresh it?"
Click the **Refresh** icon (circular arrows) at the top right of the header bar, next to the
Dashboard icon. It reloads the data behind the screen you're on without a browser reload, so
you keep your place and anything you've typed into a form. Screens also update on their own
within about 20 seconds when the ledger changes, but changes that don't post to the ledger
(bank feed rows, contacts, rules, document requests) may need the Refresh icon.

### "How do I get a vendor's account number to print on the check memo?"
Open the vendor under **Contacts**, click **Edit**, and fill in **Account number** in the
*Vendor Details* section (the number the vendor assigned to you — utility account, customer
number, etc.). It is a text field, so dashes, letters and leading zeros are kept exactly. From
then on, **Write Check** fills the Printed Memo with `Acct <number>` when you pick that vendor,
and **Pay Bills** checks default to `Acct <number> - <invoice numbers>`. You can still edit the
memo on Write Check, in the *Memo on check* field on Pay Bills, or per check in the Print Checks
queue. Vendors with no account number print the same memo as before.

### "Why did my whole team get an email when a client categorized transactions?" / "Who gets the 'categorized N transactions' email?"
Since October 2026 that email goes only to the people on that client's own list:
**Practice → Uncategorized → Client suggested → Email notifications** (owners of
self-managed books: Banking → Uncategorized → Suggested). Tick the staff who should get
it; nobody ticked means no email — the answers still show as unread on the Client
suggested tab. Every client starts with nobody ticked. Before this change the email went
to every reviewer with access to the client. Document-request upload emails are separate
and follow each request rule's "Email staff when the client submits" list.
