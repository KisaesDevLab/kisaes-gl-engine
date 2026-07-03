## Advanced Features

### Batch Entry
Batch entry is a spreadsheet-style interface for entering many transactions at once. Open
it from **Transactions → Batch Entry →**.

1. **Pick a transaction type** — Expenses, Deposits, Credit Card Charges/Credits, Invoices,
   Bills, Credit Memos, Journal Entries, or Customer Payments.
2. **Enter rows** — the grid auto-extends as you fill the last row. You can also paste
   from Excel or Google Sheets (Tab + Enter delimiters), or import a CSV file.
3. **Validate** — each row shows a green checkmark (valid), red X (invalid), or orange
   triangle (warning). Click **Validate** to check all rows before saving.
4. **Save All** — posts all valid rows. A confirmation shows how many transactions were
   created and any new contacts that were auto-created.

The columns change depending on the type. For example, Expenses show Date, Ref No, Payee,
Account, Memo, Amount. Journal Entries show Date, Ref No, Account, Name, Memo, Debit, Credit.

### Bulk Import (Data Migration)
**Bulk Import →** (sidebar) migrates bookkeeping data from another system via CSV or
XLSX file — chart of accounts, contacts, trial balance, or GL transactions. Formats
from Accounting Power and QuickBooks Online are recognized.

1. **Upload** — pick the file, the data kind, and the source system. The server
   parses and validates it.
2. **Preview** — every parsed row is shown (up to 5,000), with any validation errors
   flagged and an explicit count of how many rows will import on commit.
3. **Commit** — posts the data. If there are errors, fix the file and re-upload
   before committing.

### Recurring Transactions
Turn any transaction into a recurring schedule by clicking **Make Recurring** on the
transaction detail page.

- **Frequency:** Daily, Weekly, Monthly, Quarterly, or Annually.
- **Interval:** e.g., "Every 2 weeks" or "Every 3 months."
- **Mode:** **Auto-post** creates the transaction automatically on schedule.
  **Reminder only** sends you a notification to post it manually.
- **Start / End Date:** when the schedule begins and optionally when it stops.

A preview shows the next 5 occurrence dates. Manage all schedules from
**Recurring Transactions →** in the sidebar.

### Products & Services (Items)
Items are reusable line entries for invoices. Manage them under **Products & Services →**
in the sidebar. Each item has:

- **Name** (required) — what appears on the invoice line
- **Description** — longer detail text
- **Unit Price** — default price (can be overridden per invoice)
- **Income Account** — which revenue account to credit
- **Taxable** — whether sales tax applies

When creating an invoice, select an item from the line item dropdown to auto-fill the
description and price.

### Duplicate Detection
Vibe MyBooks automatically flags potentially duplicate transactions. Review them at
**Duplicate Review →** in the sidebar. For each potential duplicate pair, you can:

- **Dismiss** — mark as not a duplicate (they're different transactions)
- **Merge** — combine into one transaction

### Account Register
The register view is an inline ledger for any account. Go to **Chart of Accounts →**,
then click the register icon next to an account (or click the account name). It shows
every transaction that hits that account in date order, with running balance.

### Chart of Accounts Bulk Edit
Click **Bulk Edit** on **Chart of Accounts →** to edit many accounts at once in an
inline table. Change account number, name, type, and detail type directly in the
grid — only the rows you actually changed are saved. Swapping two account numbers is
supported. System accounts keep their type locked, though you can still rename or
renumber them.

### Tags
Tags let you label transactions for cross-cutting reporting (projects, departments,
locations, properties). Manage tags under **Settings → Tags →**.

- **Groups** — organize related tags (e.g., "Department" group with tags "Sales",
  "Engineering", "Operations").
- **Single-Select Groups** — a transaction can only have one tag from a single-select
  group. Multi-select groups allow multiple.
- Tags can be applied when creating or editing any transaction.
- Filter by tags on reports to see activity for specific projects or departments.

### Budgets
Create and manage budgets under **Budgets →** in the sidebar.

1. **Select a fiscal year** and click **Create Budget**.
2. **Quick Setup** options: Start Blank, Copy Last Year's Budget, Use Last Year's Actuals,
   or Actuals + Growth % (enter a percentage increase).
3. **Monthly view** shows 12 columns (one per month) plus an annual total. **Annual view**
   shows a single amount per account.
4. Revenue accounts (blue) and expense accounts (red) are separated. Net Income is
   calculated automatically.

Helpful shortcuts:
- **Spread Annual** — distributes an annual total evenly across all 12 months.
- **Copy Prior Year** — copies values from last year's budget.
- **Fill from Actuals** — fills with last year's actual amounts.
- **Adjust %** — increase or decrease all budget amounts by a percentage.
- **Hide Zero** — filter out accounts with no budget entered.

Budgets anchor to the company's fiscal year: the editor's monthly columns run in
fiscal month order (e.g., Jul–Jun for a July fiscal year start), and Budget vs.
Actual prorates budget amounts to the reporting window you select.

Run **Reports → Budget vs. Actual →** to compare your budget against actual results.
