export const swaggerSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Vibe MyBooks API',
    version: '2.0.0',
    description: 'Public API for Vibe MyBooks — a self-hosted bookkeeping application. Supports API key and JWT authentication.',
    contact: { name: 'Kisaes LLC' },
    license: { name: 'PolyForm Internal Use License 1.0.0', url: 'https://polyformproject.org/licenses/internal-use/1.0.0' },
  },
  servers: [
    { url: '/api/v2', description: 'API v2' },
  ],
  security: [
    { ApiKeyAuth: [] },
    { BearerAuth: [] },
  ],
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: 'API key generated from Settings > API Keys. Format: sk_live_...',
      },
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT access token from POST /api/v1/auth/login',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              message: { type: 'string' },
              code: { type: 'string' },
            },
          },
        },
      },
      Account: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          accountNumber: { type: 'string', example: '10100' },
          name: { type: 'string', example: 'Cash' },
          accountType: { type: 'string', enum: ['asset', 'liability', 'equity', 'revenue', 'expense'] },
          detailType: { type: 'string' },
          balance: { type: 'string', example: '15000.0000' },
          isActive: { type: 'boolean' },
          isSystem: { type: 'boolean' },
        },
      },
      Contact: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          displayName: { type: 'string', example: 'Acme Corp' },
          contactType: { type: 'string', enum: ['customer', 'vendor', 'both'] },
          email: { type: 'string' },
          phone: { type: 'string' },
        },
      },
      Transaction: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          txnType: { type: 'string', enum: ['expense', 'deposit', 'transfer', 'journal_entry', 'cash_sale', 'invoice', 'customer_payment'] },
          txnNumber: { type: 'string' },
          txnDate: { type: 'string', format: 'date' },
          status: { type: 'string', enum: ['posted', 'void'] },
          total: { type: 'string', example: '1500.0000' },
          memo: { type: 'string' },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                accountId: { type: 'string', format: 'uuid' },
                debit: { type: 'string' },
                credit: { type: 'string' },
                description: { type: 'string' },
              },
            },
          },
        },
      },
      Invoice: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          txnNumber: { type: 'string', example: 'INV-1001' },
          txnDate: { type: 'string', format: 'date' },
          dueDate: { type: 'string', format: 'date' },
          contactId: { type: 'string', format: 'uuid' },
          invoiceStatus: { type: 'string', enum: ['draft', 'sent', 'partial', 'paid', 'void'] },
          subtotal: { type: 'string' },
          taxAmount: { type: 'string' },
          total: { type: 'string' },
          balanceDue: { type: 'string' },
        },
      },
      Item: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string', example: 'Web Design' },
          description: { type: 'string' },
          unitPrice: { type: 'string', example: '150.00' },
          incomeAccountId: { type: 'string', format: 'uuid' },
          isTaxable: { type: 'boolean' },
          isActive: { type: 'boolean' },
        },
      },
      Tenant: {
        type: 'object',
        properties: {
          tenantId: { type: 'string', format: 'uuid' },
          tenantName: { type: 'string' },
          role: { type: 'string' },
        },
      },
      TrialBalance: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          startDate: { type: 'string', format: 'date' },
          endDate: { type: 'string', format: 'date' },
          data: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                account_number: { type: 'string' },
                name: { type: 'string' },
                account_type: { type: 'string' },
                total_debit: { type: 'number' },
                total_credit: { type: 'number' },
              },
            },
          },
          totalDebits: { type: 'number' },
          totalCredits: { type: 'number' },
        },
      },
      ProfitAndLoss: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          revenue: { type: 'array', items: { type: 'object' } },
          expenses: { type: 'array', items: { type: 'object' } },
          totalRevenue: { type: 'number' },
          totalExpenses: { type: 'number' },
          netIncome: { type: 'number' },
        },
      },
      BalanceSheet: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          assets: { type: 'array', items: { type: 'object' } },
          liabilities: { type: 'array', items: { type: 'object' } },
          equity: { type: 'array', items: { type: 'object' } },
          totalAssets: { type: 'number' },
          totalLiabilities: { type: 'number' },
          totalEquity: { type: 'number' },
        },
      },
    },
  },
  paths: {
    // ─── Context ──────────────────────────────────────────────
    '/me': {
      get: {
        tags: ['Context'],
        summary: 'Get current user and tenant info',
        responses: {
          200: { description: 'User info with companies and tenants', content: { 'application/json': { schema: { type: 'object' } } } },
          401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/tenants': {
      get: {
        tags: ['Context'],
        summary: 'List accessible tenants',
        responses: {
          200: { description: 'Tenant list', content: { 'application/json': { schema: { type: 'object', properties: { tenants: { type: 'array', items: { $ref: '#/components/schemas/Tenant' } } } } } } },
        },
      },
    },
    '/tenants/switch': {
      post: {
        tags: ['Context'],
        summary: 'Switch active tenant',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['tenantId'], properties: { tenantId: { type: 'string', format: 'uuid' } } } } } },
        responses: { 200: { description: 'New JWT tokens for the target tenant' } },
      },
    },
    // ─── Accounts ─────────────────────────────────────────────
    '/accounts': {
      get: {
        tags: ['Chart of Accounts'],
        summary: 'List all accounts',
        responses: { 200: { description: 'Account list', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Account' } }, total: { type: 'integer' } } } } } } },
      },
      post: {
        tags: ['Chart of Accounts'],
        summary: 'Create an account',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'accountType'], properties: { name: { type: 'string' }, accountNumber: { type: 'string' }, accountType: { type: 'string', enum: ['asset', 'liability', 'equity', 'revenue', 'expense'] }, detailType: { type: 'string' } } } } } },
        responses: { 201: { description: 'Created account' } },
      },
    },
    '/accounts/{id}': {
      get: {
        tags: ['Chart of Accounts'],
        summary: 'Get account detail',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'Account detail' }, 404: { description: 'Not found' } },
      },
    },
    // ─── Contacts ─────────────────────────────────────────────
    '/contacts': {
      get: {
        tags: ['Contacts'],
        summary: 'List all contacts',
        responses: { 200: { description: 'Contact list' } },
      },
      post: {
        tags: ['Contacts'],
        summary: 'Create a contact',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['displayName'], properties: { displayName: { type: 'string' }, contactType: { type: 'string', enum: ['customer', 'vendor', 'both'] }, email: { type: 'string' }, phone: { type: 'string' } } } } } },
        responses: { 201: { description: 'Created contact' } },
      },
    },
    '/contacts/{id}': {
      get: {
        tags: ['Contacts'],
        summary: 'Get contact detail',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'Contact detail' }, 404: { description: 'Not found' } },
      },
    },
    // ─── Transactions ─────────────────────────────────────────
    '/transactions': {
      get: {
        tags: ['Transactions'],
        summary: 'List transactions',
        parameters: [
          { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Search memo or number' },
          { name: 'txnType', in: 'query', schema: { type: 'string' }, description: 'Filter by type' },
          { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
        ],
        responses: { 200: { description: 'Transaction list with pagination' } },
      },
      post: {
        tags: ['Transactions'],
        summary: 'Create a transaction',
        description: 'Creates a transaction of the specified type. The request body varies by txnType.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['txnType', 'txnDate'],
                properties: {
                  txnType: { type: 'string', enum: ['expense', 'deposit', 'transfer', 'journal_entry', 'cash_sale'] },
                  txnDate: { type: 'string', format: 'date' },
                  contactId: { type: 'string', format: 'uuid' },
                  memo: { type: 'string' },
                  amount: { type: 'string', description: 'For expense/deposit/transfer' },
                  payFromAccountId: { type: 'string', format: 'uuid', description: 'For expense' },
                  expenseAccountId: { type: 'string', format: 'uuid', description: 'For single-line expense' },
                  lines: { type: 'array', description: 'For multi-line expense or journal entry', items: { type: 'object' } },
                },
              },
              examples: {
                expense: { summary: 'Expense', value: { txnType: 'expense', txnDate: '2026-04-01', payFromAccountId: '...', amount: '150.00', lines: [{ expenseAccountId: '...', amount: '150.00' }] } },
                deposit: { summary: 'Deposit', value: { txnType: 'deposit', txnDate: '2026-04-01', depositToAccountId: '...', amount: '500.00', revenueAccountId: '...' } },
                journal_entry: { summary: 'Journal Entry', value: { txnType: 'journal_entry', txnDate: '2026-04-01', lines: [{ accountId: '...', debit: '100.00', credit: '0' }, { accountId: '...', debit: '0', credit: '100.00' }] } },
              },
            },
          },
        },
        responses: { 201: { description: 'Created transaction' }, 400: { description: 'Validation error' } },
      },
    },
    '/transactions/{id}': {
      get: {
        tags: ['Transactions'],
        summary: 'Get transaction with journal lines',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'Transaction detail with journal lines' }, 404: { description: 'Not found' } },
      },
    },
    // ─── Invoices ─────────────────────────────────────────────
    '/invoices': {
      get: {
        tags: ['Invoices'],
        summary: 'List invoices',
        parameters: [
          { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
        ],
        responses: { 200: { description: 'Invoice list' } },
      },
      post: {
        tags: ['Invoices'],
        summary: 'Create an invoice',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['txnDate', 'contactId', 'lines'],
                properties: {
                  txnDate: { type: 'string', format: 'date' },
                  dueDate: { type: 'string', format: 'date' },
                  contactId: { type: 'string', format: 'uuid' },
                  paymentTerms: { type: 'string', enum: ['due_on_receipt', 'net_15', 'net_30', 'net_60', 'net_90'] },
                  memo: { type: 'string' },
                  lines: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['accountId', 'quantity', 'unitPrice'],
                      properties: {
                        accountId: { type: 'string', format: 'uuid' },
                        description: { type: 'string' },
                        quantity: { type: 'string' },
                        unitPrice: { type: 'string' },
                        isTaxable: { type: 'boolean' },
                        taxRate: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Created invoice with auto-assigned number' } },
      },
    },
    '/invoices/{id}': {
      get: {
        tags: ['Invoices'],
        summary: 'Get invoice detail',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'Invoice detail' } },
      },
      put: {
        tags: ['Invoices'],
        summary: 'Update an invoice',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { 200: { description: 'Updated invoice' }, 400: { description: 'Cannot edit void or paid invoices' } },
      },
    },
    // ─── Items ────────────────────────────────────────────────
    '/items': {
      get: {
        tags: ['Items'],
        summary: 'List items/products',
        responses: { 200: { description: 'Item list' } },
      },
      post: {
        tags: ['Items'],
        summary: 'Create an item',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'incomeAccountId'], properties: { name: { type: 'string' }, description: { type: 'string' }, unitPrice: { type: 'string' }, incomeAccountId: { type: 'string', format: 'uuid' }, isTaxable: { type: 'boolean', default: true } } } } } },
        responses: { 201: { description: 'Created item' } },
      },
    },
    // ─── Reports ──────────────────────────────────────────────
    '/reports/trial-balance': {
      get: {
        tags: ['Reports'],
        summary: 'Trial Balance',
        description: 'Returns trial balance with year-end closing applied. Revenue/expense accounts show only current fiscal year activity.',
        parameters: [
          { name: 'start_date', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Start date (defaults to Jan 1 current year)' },
          { name: 'end_date', in: 'query', schema: { type: 'string', format: 'date' }, description: 'End date (defaults to today)' },
        ],
        responses: { 200: { description: 'Trial balance data', content: { 'application/json': { schema: { $ref: '#/components/schemas/TrialBalance' } } } } },
      },
    },
    '/reports/profit-loss': {
      get: {
        tags: ['Reports'],
        summary: 'Profit & Loss (Income Statement)',
        parameters: [
          { name: 'start_date', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'end_date', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'basis', in: 'query', schema: { type: 'string', enum: ['accrual', 'cash'], default: 'accrual' } },
        ],
        responses: { 200: { description: 'P&L data', content: { 'application/json': { schema: { $ref: '#/components/schemas/ProfitAndLoss' } } } } },
      },
    },
    '/reports/balance-sheet': {
      get: {
        tags: ['Reports'],
        summary: 'Balance Sheet',
        description: 'Point-in-time balance sheet with automatic retained earnings calculation.',
        parameters: [
          { name: 'as_of_date', in: 'query', schema: { type: 'string', format: 'date' }, description: 'As-of date (defaults to today)' },
          { name: 'basis', in: 'query', schema: { type: 'string', enum: ['accrual', 'cash'], default: 'accrual' } },
        ],
        responses: { 200: { description: 'Balance sheet data', content: { 'application/json': { schema: { $ref: '#/components/schemas/BalanceSheet' } } } } },
      },
    },
    '/reports/cash-flow': {
      get: {
        tags: ['Reports'],
        summary: 'Cash Flow Statement',
        parameters: [
          { name: 'start_date', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'end_date', in: 'query', schema: { type: 'string', format: 'date' } },
        ],
        responses: { 200: { description: 'Cash flow data' } },
      },
    },
    '/reports/general-ledger': {
      get: {
        tags: ['Reports'],
        summary: 'General Ledger',
        parameters: [
          { name: 'start_date', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'end_date', in: 'query', schema: { type: 'string', format: 'date' } },
        ],
        responses: { 200: { description: 'General ledger entries' } },
      },
    },
    // ─── Docs ─────────────────────────────────────────────────
    '/docs': {
      get: {
        tags: ['Documentation'],
        summary: 'API documentation (JSON)',
        responses: { 200: { description: 'API endpoint reference' } },
      },
    },
  },
  tags: [
    { name: 'Context', description: 'User, tenant, and company context' },
    { name: 'Chart of Accounts', description: 'Manage accounts' },
    { name: 'Contacts', description: 'Customers and vendors' },
    { name: 'Transactions', description: 'Record and query financial transactions' },
    { name: 'Invoices', description: 'Create and manage invoices' },
    { name: 'Items', description: 'Products and services catalog' },
    { name: 'Reports', description: 'Financial reports' },
    { name: 'Documentation', description: 'API reference' },
  ],
};
