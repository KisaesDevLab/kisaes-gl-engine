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
that lets external AI assistants (Claude and others) work in your books:
enter transactions, work the bank feed, reconcile accounts, run reports.
It follows the MCP 2025-11-25 specification (JSON-RPC over HTTP POST).

Enable MCP:
1. System-wide under **Admin → MCP / API Access →**
2. Per-company under **Settings → Company Profile → API & MCP Access →**
   (off by default — must be explicitly enabled for each company)
3. To let people sign in from Claude instead of pasting a key, also turn on
   **OAuth sign-in** under **Admin → MCP / API Access →**

**Two ways to connect:**
- **Sign in (OAuth)** — in Claude, add a custom connector with the URL
  `https://your-instance/mcp`. Claude sends you to Vibe MyBooks to sign in
  and approve. The connector then acts as you. Claude's connectors call
  from Anthropic's servers, so the instance must be reachable from the
  internet at a public HTTPS address.
- **API key** — generate a key under **Settings → API Keys →** and send it
  as `Authorization: Bearer <key>`. For Claude Desktop on an instance that
  is only reachable inside the office, run the `mcp-remote` bridge from
  `claude_desktop_config.json` with that header; it connects from the
  user's own computer.

**Firm staff and clients:** a staff member connects once, as themselves, and
reaches every client they have been given access to (Firm → Staff → Tenant
access). `list_companies` shows those clients with the person's role in
each. What they can do in a client through MCP is exactly what their role
and permission template allow in the app: read-only in a client is
read-only through MCP, whatever the key or sign-in was granted. Revoking a
person's access to a client takes effect on their next call. Each connection
keeps its own active client (`set_active_company`), and every result names
the client it ran in. A call that changes data uses the remembered client
only on a connection that sends back the session id the server issued;
otherwise it must name the client (`company_id`) or it is refused, so a
choice made in another chat can never decide where an entry posts. Every
entry is stamped with the company it was made in, and an id that belongs
to another client is refused. A client with accounts hidden from the caller
(sensitive accounts) cannot be opened through MCP by that caller.

**Tool groups (89 tools):** clients, chart of accounts, contacts,
transactions (including void), invoices, bills and AP, bill payments,
vendor credits, customer payments, checks, recurring, budgets, dashboard,
bank feed, reconciliation (start, read the worksheet, tick lines, auto-clear
against a statement, complete, discard, undo), attachments, items, tags,
search, and financial reports. Each tool publishes a JSON Schema for its
arguments; lists such as journal lines are arrays.

**Resources (read-only snapshots):** `kisbooks://companies`, and under
`kisbooks://company/{company_id}/`: chart-of-accounts, contacts,
recent-transactions, bank-feed/pending, invoices/overdue, bills/payable,
bill-payments, vendor-credits, recurring, budgets, checks/print-queue,
reconciliations, items, tags, dashboard.

**Scopes gate each tool:** `read`, `write`, `reports`, `invoicing`,
`banking` (and `all`, for API keys). Assign scopes when generating the key
or approving the sign-in. A tool also needs the matching permission in the
client's books (for example Banking for the bank feed and reconciliation).
A failed call comes back as an error result that starts with a code, such
as `PERMISSION_DENIED`, `MCP_DISABLED` or `COMPANY_REQUIRED`. Entries in a
closed period are refused (the closing-date password cannot be given
through MCP). Every MCP call is audited (tool, client, sanitized
parameters, status, duration) — view under **Admin → MCP Audit Log**.

**A client file with more than one company:** reports and the transaction,
invoice, bill and bank feed lists show the company named. A transaction,
bill, bank feed item or recurring schedule that belongs to another company
of the file is refused (`WRONG_COMPANY` or not found), and nothing is
changed. The chart of accounts, contacts, tags and the dashboard figures
cover the whole file, as they do in the app; so does reconciliation, which
follows the bank account. A file with one company is not filtered at all.

**send_invoice** marks an invoice as sent. It does not email the invoice;
email it from the invoice in the app.

### Tax1099.com E-Filing (Firms)
Firms can e-file 1099s with the IRS through Tax1099.com (Zenwork). A firm admin
configures the integration under **Firm → Settings** — enter the Tax1099 API
credentials (stored encrypted), choose sandbox or production, and use
**Test Connection** to verify before saving.

Once enabled, submit filings from the **E-file with Tax1099** panel in the
**1099 Center**. Only super-admins, firm admins, or accountants can submit.
Each submission is tracked with the provider's reference number, and you can
refresh its status from the same panel. Vendors missing a TIN or address are
skipped and listed in the submission result so you can fix them and resubmit.

### OAuth 2.0
Vibe MyBooks is an OAuth 2.1 authorization server for its MCP endpoint
(authorization code with PKCE; discovery at
`/.well-known/oauth-protected-resource` and
`/.well-known/oauth-authorization-server`). It is off until an
administrator turns on **OAuth sign-in** under **Admin → MCP / API Access →**.
A connector registers itself, sends the user to a consent screen showing the
requesting app, where it will send the sign-in and the requested scopes, and
the user approves or declines. An app that registers itself may only redirect
to the user's own computer or to an address the operator allows
(`MCP_OAUTH_REDIRECT_ALLOWLIST`, by default Claude's connector callback).
Access tokens last one hour and are renewed with a rotating refresh token.
Authorized apps appear under **Settings → Connected Apps**, where users can
revoke access.
