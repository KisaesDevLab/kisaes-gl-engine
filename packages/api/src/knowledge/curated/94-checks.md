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
- **Check on Top** — check on the top 3.5" of the page, two identical voucher
  stubs below (one for the vendor, one file copy). Matches QuickBooks-compatible
  voucher stock perforated at 3.5" and 7".
- **Check in Middle** — stub on top, check in the middle, stub on the bottom.
  Matches QuickBooks-compatible middle check stock perforated at 3.5" and 7".

On both layouts the payee's name and mailing address print below the amount
line, positioned to show through the bottom window of a #8/#9 double-window
envelope (toggle: "Payee address block" in Check Print Settings).
- **Z-Fold Pressure Seal** — for 8.5×11 pressure-seal self-mailer stock (e.g. blue
  Z-fold forms). The check prints in the middle panel with remittance stubs above
  and below, positioned for the Z-fold creases at 3.667" and 7.333". When printing
  on blank stock, the MICR line (routing, account, check number) is printed too.
  Fold guides help you verify positioning, and the X/Y alignment offsets fine-tune
  placement for your printer.

### Signature Images on Checks
Checks can print with a signature image in the signature area:

- **Setup (owner only):** **Settings → Check Print Settings → Check Signatures**.
  Upload a PNG or JPEG up to 600×200 pixels (larger uploads are rejected — resize
  first). Each signature can have an optional **max amount**; checks above it print
  with a blank signature line for hand-signing.
- **Who can use it:** each signature has its own authorized-user list (the "Users"
  button). A user not assigned to any signature prints blank checks. One user can
  be authorized for several signatures (e.g., an assistant printing with the
  owner's signature) and picks one at print time.
- **Security:** signature images are stored encrypted on the server and only ever
  served to authorized users. Printing WITH a signature always requires step-up
  verification — the user re-enters their password, or their 6-digit authenticator
  code if two-factor is enrolled. One verification covers ~10 minutes of printing.
  Every signed print records which signature was used (audit trail).
- **On the check:** the image prints sitting on the signature line, scaled to fit
  the signature area; the line and "AUTHORIZED SIGNATURE" caption always print on
  top of the image. Over-cap checks in the same batch print unsigned, and the
  Print Checks page shows an amber warning listing them before you print.
