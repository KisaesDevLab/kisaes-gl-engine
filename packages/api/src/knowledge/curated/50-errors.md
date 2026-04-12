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
