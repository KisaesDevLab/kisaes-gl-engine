## API & Integrations

### Plaid Bank Connections
Plaid connects your bank accounts directly to Vibe MyBooks for automatic transaction
import. Set up under **Admin → Plaid Integration →** (requires Plaid API credentials).

Once configured, users connect banks via **Banking → Bank Connections →**:
1. Click **Connect Bank** and search for your bank.
2. Log in through Plaid's secure window.
3. Select which accounts to import.
4. Transactions sync automatically (you can also click **Sync** to pull immediately).

Imported transactions appear in the **Bank Feed →** for categorization or matching
against existing transactions.

### API Keys
Generate API keys for external integrations under **Settings → API Keys →**. Each key
has a name and can be revoked at any time. API keys provide programmatic access to your
company's data for automation, reporting tools, or custom integrations.

### MCP Server (AI Assistant Integration)
Vibe MyBooks includes an MCP (Model Context Protocol) server that lets external AI
assistants (like Claude) interact with your accounting data. Configure under
**Admin → MCP / API Access →**.

The MCP server provides read-only access to accounting data, enabling AI assistants to
answer questions about your books, generate summaries, and help with analysis — all
without being able to modify data.

### OAuth 2.0
Vibe MyBooks supports OAuth 2.0 for third-party application authentication. This allows
external apps to connect and access data on behalf of a user with proper authorization.
