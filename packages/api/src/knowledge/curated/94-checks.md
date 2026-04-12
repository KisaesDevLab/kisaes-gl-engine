## Checks

### Writing a Check
Go to **Write Check →** in the sidebar to create a new check.

**Check Fields:**
- **Bank Account** — the account the check draws from (required)
- **Date** — check date
- **Pay to the Order of** — select a contact (vendor or other payee)
- **Payee Name on Check** — auto-filled from the contact, but you can override it
  (useful when the legal name differs from how you know the vendor)
- **Amount** — the check total (automatically converted to words for the check face,
  e.g., "Two Hundred Thirty-Four and 50/100 Dollars")
- **Printed Memo** — appears on the physical check
- **Internal Memo** — for your records only, not printed

**Expense Lines:**
Below the check header, add one or more expense line items with Account, Description,
and Amount. If you split the check across multiple accounts, the lines must total the
check amount.

**Saving:**
- **Save** — records the check immediately (posted to the ledger).
- **Save & Queue for Print** — records the check and adds it to the print queue.

The journal entry is the same as an expense: `DR Expense Account(s) / CR Bank Account`.

### Printing Checks
Go to **Print Checks →** to see all checks queued for printing.

1. Review the list of queued checks (payee, amount, date).
2. Select which checks to print (or select all).
3. Click **Print** to send to your printer.

Check print settings (check layout, starting check number, alignment) can be configured
under **Settings → Check Print Settings →**. A test print option lets you verify
alignment before printing real checks.
