## API & Integrations

### REST API (v2)
Vibe MyBooks exposes a stable REST API under **`/api/v2/`** for external
integrations, automation, and custom reporting. All endpoints return JSON
and use string amounts (`"1234.5600"`) to preserve decimal precision.

**Resource coverage in v2:**
- Context: `/me`, `/tenants`, `/tenants/switch`, `/docs`
- Chart of accounts, contacts, items, tags
- Transactions (expense / deposit / transfer / journal_entry / cash_sale),
  void, tagging
- Invoices and customer payments (`/payments/receive`)
- Bills (AP), bill-payments, vendor-credits
- Checks and the print queue
- Recurring schedules (list / create / update / deactivate / post-now)
- Budgets (with budget-vs-actual)
- Dashboard snapshots (cash position, AR/AP summary, action items,
  trend, snapshot)
- Bank connections, bank feed (list / categorize / match / exclude /
  bulk-approve), reconciliation history and start
- Attachment metadata
- Financial reports: trial balance, P&L, balance sheet, cash flow,
  general ledger, AR aging, expense by vendor, expense by category,
  vendor balance, customer balance, 1099 vendor summary, sales tax
  liability, check register

**What is still v1-only:** file uploads (multipart), Plaid link-token
minting, reconciliation line updates and complete/undo, check print batch,
bank rules, batch entry, import/export, backup, admin, AI chat, estimates.

### API Keys
Generate API keys for external integrations under
**Settings → API Keys →**. Each key has a name, a role
(readonly / accountant / owner), a set of scopes, and an optional
expiration. Keys can be restricted to specific companies within a tenant.
The full key value is shown **only once** at creation. API keys authenticate
via the `X-API-Key` header on the REST API, or `Authorization: Bearer`
on MCP.

Rate limit: 100 requests per minute per key on the REST API, 60 requests
per minute per key on MCP. JWT tokens are also supported for web / mobile
app flows.

### Plaid Bank Connections
Plaid connects your bank accounts directly to Vibe MyBooks for automatic
transaction import. Set up under **Admin → Plaid Integration →**
(requires Plaid API credentials).

Once configured, users connect banks via **Banking → Bank Connections →**:
1. Click **Connect Bank** and search for your bank.
2. Log in through Plaid's secure window.
3. Select which accounts to import.
4. Transactions sync automatically (you can also click **Sync** to pull
   immediately).

Imported transactions appear in the **Bank Feed →** for categorization or
matching against existing transactions.

### MCP Server (AI Assistant Integration)
Vibe MyBooks includes an MCP (Model Context Protocol) server at **`/mcp`**
that lets external AI assistants (Claude, GPT, etc.) interact with your
accounting data. MCP supports **both read and write operations** subject
to the key's scopes.

Enable MCP:
1. System-wide under **Admin → MCP / API Access →**
2. Per-company under **Settings → Company Profile → API & MCP Access →**
   (off by default — must be explicitly enabled for each company)

**Tool groups (79+ tools):** context, chart of accounts, contacts,
transactions (including void), invoices, bills and AP, bill payments,
vendor credits, customer payments, checks, recurring, budgets, dashboard,
bank feed, reconciliation, attachments, items, tags, search, and
financial reports.

**Resources (read-only snapshots):** `kisbooks://companies`, and under
`kisbooks://company/{id}/`: chart-of-accounts, contacts,
recent-transactions, bank-feed/pending, invoices/overdue, bills/payable,
bill-payments, vendor-credits, recurring, budgets, checks/print-queue,
reconciliations, items, tags, dashboard.

**Scopes gate each tool:** `all`, `read`, `write`, `reports`, `invoicing`,
`banking`. Assign scopes when generating the key. Every MCP call is
audited (tool, company, sanitized parameters, status, duration) —
view under **Admin → MCP Audit Log**.

### OAuth 2.0
Vibe MyBooks supports OAuth 2.0 for third-party application authentication
(authorization code flow). Third-party apps redirect users to a consent
screen showing the requesting app and requested scopes; users can then
authorize or deny. Authorized apps appear under
**Settings → Connected Apps**, where users can revoke access.
