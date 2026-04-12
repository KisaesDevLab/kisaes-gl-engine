## Error Resolution

| Error | Cause | Fix |
|---|---|---|
| "Cannot create or modify transactions on or before the lock date" | Date is in a closed period | Pick a date after the lock date, or open **Settings → Closing Date** to adjust the lock date |
| "Transaction does not balance" | Sum of debits ≠ sum of credits on a journal entry | Check the line amounts; the totals at the bottom must match |
| "Cannot change the total on a paid bill" | The bill has payments applied; total is locked | Reallocate between expense lines so the sum still matches the original total, or void the payments first |
| "Cannot change the vendor on a paid bill" | The bill has payments applied; vendor is locked | Void the payments first, or create a new bill with the correct vendor and void the old one |
| "Cannot deactivate an account with a non-zero balance" | Account still has money in it | Either zero it out via a journal entry first, or merge it into another account |
| "Bill payment requires a bank account" | No bank account selected on Pay Bills | Pick a bank account from the dropdown — it must be an asset account |
| "AI bill scanning is not enabled" | The chat / OCR features need an admin to set up an AI provider | Open **Admin → AI Processing →** and configure a provider, then enable AI |
| "Account number already exists" | You're trying to create or edit an account with a number that's already taken | Pick a different number, or update the existing account instead |
| "Reconciliation is already in progress" | Another reconciliation for this account is open | Finish or cancel the existing reconciliation before starting a new one |
| "Recurring schedule is not on occurrence …" | Two workers tried to post the same scheduled occurrence | Refresh the page; the other worker already created the transaction |
| "Cannot delete an active tenant" (admin) | Tenant must be disabled first | Disable the tenant via **Admin → Tenants** and then retry the deletion |
| "Passphrase must be at least 12 characters" | Backup passphrase is too short | Choose a longer passphrase — 12 characters minimum for encrypted backups |
| "Invalid recovery code" | The recovery code was already used or mistyped | Recovery codes are single-use. Check for typos, or try another code. If all codes are spent, contact your administrator |
| "SMTP connection failed" | Email settings are incorrect or the mail server is unreachable | Check your SMTP host, port, username, and password under **Settings → Email Settings →**. Use **Test Connection** to verify |
| "Duplicate file detected" | A payroll file with the same content was already imported | Check your import history — the file may have already been processed. If this is a different pay period with the same filename, rename it and try again |
| "AI provider not configured" | No AI provider has been set up | An administrator must configure an AI provider under **Admin → AI Processing →** before OCR, categorization, or chat features work |
| "Storage migration in progress" | Files are being moved between storage providers | Wait for the migration to complete (check the progress bar under **Settings → File Storage →**) before making further changes |
