## Key Terminology (Vibe MyBooks-specific)

### Payments Clearing
A temporary holding account for customer payments that have been received but
not yet deposited at the bank. When you record a customer payment, the money
goes here first. When you record a Bank Deposit, money moves from Payments
Clearing into your bank account. This mirrors real-world cash handling — you
collect several checks throughout the day, then deposit them all together.
(QuickBooks calls this "Undeposited Funds.")

### Bill vs. Expense
- A **Bill** records an obligation to a vendor that you'll pay later. It posts
  `DR Expense / CR Accounts Payable`. You then use the Pay Bills screen to pay
  it, which posts `DR Accounts Payable / CR Bank`. Use bills when the vendor
  gives you payment terms (Net 30, etc.) and you want to track what you owe.
- An **Expense** records a payment you made immediately. It posts
  `DR Expense / CR Bank` in one step. Use expenses when you paid at the
  point of sale (debit card, cash, credit card swipe) and there's no vendor
  invoice to track.

### Bill Status
- **Unpaid** — no payments or credits applied
- **Partial** — some amount paid or credited, but balance remaining
- **Paid** — fully covered by payments + credits
- **Overdue** — past due date, still unpaid or partial

### Vendor Credit
A credit memo issued by a vendor (refund, return, dispute settlement). You record
it as a vendor credit, then apply it against future bills from that vendor on the
Pay Bills screen. Applying a credit reduces the cash you owe on the bill.

### Lock Date
A date set by the company owner that prevents anyone from posting, editing, or
voiding transactions on or before that date. Used to "close the books" for a
period after taxes are filed. Found under **Settings → Closing Date**.

### Chart of Accounts (COA)
The list of accounts the company uses to categorize money — Bank, AR, Inventory,
AP, Equity, Revenue, Expenses, etc. Every journal line posts to one of these.
Vibe MyBooks ships with industry-specific COA templates that admins can edit at
runtime via **Admin → COA Templates**.

### Tags
Labels you can attach to transactions for cross-cutting reporting (e.g., projects,
departments, properties). Tags can be grouped, and a group can be set "single
select" so a transaction can only have one tag from that group.

### Accounts Receivable (AR)
Money customers owe you. Increases when you record an invoice. Decreases when
you receive a customer payment and apply it to an open invoice.

### Accounts Payable (AP)
Money you owe vendors. Increases when you enter a bill. Decreases when you pay
the bill via Pay Bills.

### Reconciliation
The process of matching the transactions in Vibe MyBooks against a bank or credit
card statement. The cleared balance after reconciliation should equal the
statement ending balance, with a difference of $0.00.

### Journal Entry
A direct posting of debits and credits to the General Ledger, used for
adjustments, accruals, or transactions that don't fit any other transaction
type. Both sides must balance (sum of debits = sum of credits).

### Closing Date / Lock Date
See "Lock Date" above. Same concept, two names depending on context.
