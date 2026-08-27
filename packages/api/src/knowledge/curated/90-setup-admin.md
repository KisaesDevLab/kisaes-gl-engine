## Setup & Administration

### Managing Multiple Companies
Vibe MyBooks supports multiple companies under one login. The company switcher is at the
top of the sidebar — click it to see all your companies.

- **Switch company** — click any company name in the dropdown. The app reloads with that
  company's data.
- **Create a new company** — click **New Company** in the dropdown. Enter a business name,
  entity type, and business type (which determines the chart of accounts template).
- For accountants/bookkeepers with multiple clients, the dropdown also shows a
  **Switch Client** section for switching between tenants.

### The Clients Screen
**View all clients…** at the bottom of the company switcher opens the **Clients**
page — every client (tenant) you have access to, in one sortable table. Click any
row to switch into that client.

Alongside Name, Role, and Last accessed, each row shows two things you would
otherwise have to open each client to find out:

- **Unprocessed bank txns** — bank feed items still waiting on someone, counting
  both untouched items and ones with a category staged but not yet approved.
  This is the same set the Bank Feed page shows with "Hide processed" on, so the
  number here is the row count you will see after clicking through. (The
  dashboard's bank-feed banner counts only untouched items, so it reads lower.)
  Sort by this column to see which client has the biggest backlog.
- **Last bank sync** — the most recent Plaid sync for that client's bank
  connections, or "No Plaid connection" (a client whose transactions arrive by
  CSV/OFX import has no Plaid item, so this column stays blank for them).
  An amber warning triangle means a connection is erroring or the client needs
  to re-enter their bank login. The time shown is when a sync was last
  *attempted*, which for a broken connection can look recent even though no
  transactions came in — that is what the triangle is telling you. Sort by this
  column ascending to bring the clients whose feeds have gone quiet to the top.

### Backup & Restore
Manage backups under **Settings → Backup & Restore →**.

**Creating a Backup:**
1. Click **Create Encrypted Backup**.
2. Set a passphrase (minimum 12 characters). A strength meter shows Weak / Fair / Strong /
   Very Strong.
3. The backup downloads as a `.vmb` file (Vibe MyBooks Backup). **If you forget the
   passphrase, the backup cannot be recovered.**

**Restoring a Backup:**
1. Upload a `.vmx` (system package), `.vmb` (portable), or `.kbk` (legacy) file. A
   multi-part disaster-recovery bundle is several `.partNNofMM.vmx` files — select
   **all of them**; every part is required.
2. For `.vmx`/`.vmb` files, enter the backup passphrase.
3. Type "RESTORE" to confirm.
4. The system validates and restores the data.

Legacy `.kbk` backups were encrypted with the server key and don't require a passphrase.

**Backup History** shows all previous backups with size, date, and format. You can download
or delete old backups from this list.

### Cloud File Storage
Configure where Vibe MyBooks stores uploaded files (attachments, receipts) under
**Settings → File Storage →**.

Supported providers:
- **Local Disk** — always available, the default
- **Dropbox** — OAuth connection
- **Google Drive** — OAuth connection
- **OneDrive** — OAuth connection
- **S3-Compatible** — any S3 service (AWS, MinIO, Cloudflare R2, etc.)

For OAuth providers, you'll need to set up API credentials and follow the redirect URI
instructions shown on the settings page. For S3, enter your bucket name, region, endpoint,
access key, secret key, and optional path prefix.

When switching providers, existing files are automatically migrated. A progress bar shows
migration status.

### Data Export
Export your data under **Settings → Export Data →**. Available formats include CSV and
Excel. You can export transactions, contacts, chart of accounts, and other data.

### Opening Balances
If you're migrating from another system, enter your opening balances under
**Settings → Opening Balances →**. This sets the starting account balances so your
reports are accurate from day one. Choose the **As-of date** — the effective date
the opening journal entry posts at, typically the first day of your fiscal year —
rather than the date you happen to enter the balances.

### Payroll Import
Import payroll data from your payroll provider under **Payroll Import** (if available
in the sidebar).

1. **Upload** — drag and drop a CSV, TSV, XLS, or XLSX file. Optionally select your
   payroll provider template for auto-detection.
2. **Map** — map your file's columns to payroll data fields. Two modes:
   - **Mode A (Employee-level)** — maps individual employee pay details
   - **Mode B (Pre-built JE)** — maps GL account descriptions to amounts
3. **Validate** — review the extracted data for accuracy.
4. **Preview & Post** — review the journal entries that will be created, then click
   **Post** to record them in the general ledger.

The system auto-detects your payroll provider and shows a confidence percentage. Duplicate
file detection warns you if the same file was already imported.

### Daily Balance Validation
A background job verifies every account's running balance against the general ledger
once a day and repairs any drift it finds. Repairs are recorded in the audit log.
No user action is needed — this keeps the balances shown in the app consistent with
the underlying journal lines.

### Admin Tenant Tools
Administrators can service a client tenant from **Admin → Tenants →** (open the
tenant's detail page):

- **Apply COA template** — seed the chart of accounts from a template. Only
  available while the tenant's chart of accounts is empty.
- **Delete chart of accounts** — remove all accounts. Only available before any
  transactions exist.
- **Delete all transactions** — a books reset: removes every transaction and journal
  line but keeps the chart of accounts, contacts, users, and settings. Bank-feed
  items reset to pending and all account balances reset to zero. Requires typing a
  confirmation phrase.
- **Create with required accounts only** — when creating a new client tenant, skip
  the full COA template and seed just the system accounts, so the client can import
  their own chart of accounts.

### Email (SMTP) Configuration
Configure outgoing email under **Settings → Email Settings →**. Enter your SMTP host,
port, username, password, and "from" address. Use **Test Connection** to verify the
settings work before saving. Email is used for sending invoices, password resets, magic
links, and 2FA codes.

### Using Gmail as the SMTP Server
Gmail works with host `smtp.gmail.com`, port `587`, and these two rules:
- **Username** must be the full email address (e.g. `you@gmail.com`) — a bare
  username is rejected with "535 BadCredentials".
- **Password** must be a 16-character **App Password**, never the regular account
  password. Google rejects regular passwords for SMTP with the same 535 error.

To obtain an App Password:
1. Turn on **2-Step Verification** for the Google account (Google Account → Security)
   — App Passwords are only available with 2-Step Verification on.
2. Go to Google Account → Security → **App Passwords** (or visit
   myaccount.google.com/apppasswords).
3. Enter a name like "Vibe MyBooks" and click **Create**.
4. Copy the 16-character password shown (spaces don't matter) and paste it into the
   Password field on the Email Settings page. Google shows it only once — generate a
   new one if it's lost.
5. Set the **From Address** to the same Gmail address, then run **Test Connection**.
