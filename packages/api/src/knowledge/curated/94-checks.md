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

**Check Layouts:**
- **Check on Top** — check at the top of the page, voucher stub below (standard
  business check stock).
- **Check in Middle** — check in the center of the page with stubs above and below.
- **Z-Fold Pressure Seal** — for 8.5×11 pressure-seal self-mailer stock (e.g. blue
  Z-fold forms). The check prints in the middle panel with remittance stubs above
  and below, positioned for the Z-fold creases at 3.667" and 7.333". When printing
  on blank stock, the MICR line (routing, account, check number) is printed too.
  Fold guides help you verify positioning, and the X/Y alignment offsets fine-tune
  placement for your printer.
