import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: [
    './src/db/schema/auth.ts',
    './src/db/schema/audit-log.ts',
    './src/db/schema/company.ts',
    './src/db/schema/accounts.ts',
    './src/db/schema/contacts.ts',
    './src/db/schema/transactions.ts',
    './src/db/schema/templates.ts',
    './src/db/schema/banking.ts',
    './src/db/schema/attachments.ts',
    './src/db/schema/items.ts',
    './src/db/schema/bank-rules.ts',
    './src/db/schema/budgets.ts',
    './src/db/schema/system-settings.ts',
    './src/db/schema/accountant-access.ts',
    './src/db/schema/user-tenant-access.ts',
    './src/db/schema/api-keys.ts',
    './src/db/schema/tfa.ts',
    './src/db/schema/passwordless.ts',
    './src/db/schema/plaid.ts',
    './src/db/schema/ai.ts',
    './src/db/schema/mcp.ts',
    './src/db/schema/storage.ts',
  ],
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] || 'postgresql://kisbooks:kisbooks@localhost:5434/kisbooks',
  },
});
