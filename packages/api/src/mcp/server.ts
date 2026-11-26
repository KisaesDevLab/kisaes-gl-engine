// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// The MCP endpoint: JSON-RPC over HTTP POST at /mcp (the Streamable HTTP
// transport, answering each request with one JSON body; no SSE stream and
// no server-held session). Built to MCP 2025-11-25, and answers the older
// revisions a client may ask for.
//
// Every call is: authenticate the bearer token -> find the tool -> validate
// its input -> check the token's scope -> resolve the client's books and the
// caller's rights in them -> run. Tools declare what they need (tools.ts);
// nothing below trusts a handler to check access.

import crypto from 'crypto';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { McpAuthContext, McpScope } from '@kis-books/shared';
import { db } from '../db/index.js';
import { accounts, bankFeedItems, contacts, reconciliations, transactions } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { buildOriginAllowlist } from '../utils/cors-allowlist.js';
import { mcpResourceUrl, protectedResourceMetadataUrl } from '../services/oauth.service.js';
import { McpAuthError, checkScope, resolveMcpAuth } from './auth.js';
import { assertAccess, getUserCompanies, issueSessionId, resolveClient, sessionFor, type McpSession } from './context.js';
import { logMcpRequest } from './audit.js';
import { checkRateLimit } from './rate-limiter.js';
import {
  McpToolError, getTool, listTools, type McpClientContext, type ToolAccess, type ToolContext,
} from './registry.js';
import './tools.js';

const SERVER_INFO = { name: 'kis-books', title: 'Vibe MyBooks', version: '2.0.0' };
/** Newest first; `initialize` answers with the client's version when it is one of these. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

const INSTRUCTIONS = [
  'Bookkeeping for one or more client companies.',
  'Start with list_companies. If it returns more than one, ask the user which client they mean, then pass its id as company_id. set_active_company can remember it for this connection, but pass company_id on every call that changes data: without it such a call may be refused.',
  'Every result ends with the client it ran in: check it matches the client the user asked about before you make another change.',
  'Before a tool that posts, voids, pays, sends or completes something, tell the user what you are about to do and in which client.',
  'Amounts are decimal strings ("125.00"); dates are YYYY-MM-DD; ids are UUIDs taken from earlier results, never invented.',
  'An error result starts with a code (PERMISSION_DENIED, MCP_DISABLED, COMPANY_REQUIRED, ...) and says what to do next.',
].join(' ');

// Bounds on every tool-call payload before it is parsed: a caller must not
// be able to hand a 10 MB argument object to a schema or a query.
const MCP_MAX_PARAMS_BYTES = 256 * 1024;

function boundedParams(params: unknown): Record<string, unknown> {
  if (params === null || params === undefined) return {};
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new McpToolError('INVALID_PARAMS', 'Tool arguments must be an object');
  }
  if (JSON.stringify(params).length > MCP_MAX_PARAMS_BYTES) {
    throw new McpToolError('INVALID_PARAMS', 'Tool arguments exceed the maximum size');
  }
  return params as Record<string, unknown>;
}

// ─── Resources ──────────────────────────────────────────────────

interface ResourceDef {
  name: string;
  description: string;
  scope: McpScope;
  access: ToolAccess;
  read: (client: McpClientContext) => Promise<unknown>;
}

const view = (...resources: ToolAccess['resources']): ToolAccess => ({ resources, action: 'read' });

// A resource shows the company it was asked for: its rows and the rows of
// the client file that carry no company, as the tools do (tools.ts).
const ofCompany = (c: McpClientContext) => or(isNull(transactions.companyId), eq(transactions.companyId, c.companyId));

const COMPANY_RESOURCES: Record<string, ResourceDef> = {
  'chart-of-accounts': {
    name: 'Chart of Accounts', description: 'Full COA for a company', scope: 'read', access: view('accounts'),
    read: (c) => db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.isActive, true))),
  },
  contacts: {
    name: 'Contacts', description: 'Contact list', scope: 'read', access: view('contacts'),
    read: (c) => db.select().from(contacts).where(eq(contacts.tenantId, c.tenantId)).limit(200),
  },
  'recent-transactions': {
    name: 'Recent Transactions', description: 'Last 50 transactions', scope: 'read', access: view('transactions'),
    read: (c) => db.select().from(transactions).where(and(eq(transactions.tenantId, c.tenantId), ofCompany(c))).orderBy(desc(transactions.txnDate)).limit(50),
  },
  'bank-feed/pending': {
    name: 'Pending Bank Feed', description: 'Pending bank feed items', scope: 'banking', access: view('banking'),
    read: (c) => db.select().from(bankFeedItems).where(and(
      eq(bankFeedItems.tenantId, c.tenantId), eq(bankFeedItems.status, 'pending'),
      sql`(${bankFeedItems.companyId} = ${c.companyId} OR (${bankFeedItems.companyId} IS NULL AND NOT EXISTS (
        SELECT 1 FROM bank_connections bc WHERE bc.id = ${bankFeedItems.bankConnectionId}
          AND bc.company_id IS NOT NULL AND bc.company_id <> ${c.companyId})))`,
    )).limit(100),
  },
  'invoices/overdue': {
    name: 'Overdue Invoices', description: 'Overdue invoices', scope: 'read', access: view('invoices'),
    read: (c) => db.select().from(transactions)
      .where(and(eq(transactions.tenantId, c.tenantId), ofCompany(c), sql`${transactions.txnType}::text = 'invoice'`, sql`due_date < CURRENT_DATE`)).limit(50),
  },
  'bills/payable': {
    name: 'Payable Bills', description: 'Unpaid bills with balance due', scope: 'read', access: view('bills'),
    read: async (c) => (await import('../services/bill.service.js')).getPayableBills(c.tenantId, { companyId: c.companyId, companyIncludesNull: true }),
  },
  'bill-payments': {
    name: 'Bill Payments', description: 'Recent bill payments', scope: 'read', access: view('pay_bills'),
    read: async (c) => (await import('../services/bill-payment.service.js')).listBillPayments(c.tenantId, { limit: 100, offset: 0, companyId: c.companyId }),
  },
  'vendor-credits': {
    name: 'Vendor Credits', description: 'Vendor credits with remaining balance', scope: 'read', access: view('vendor_credits'),
    read: async (c) => (await import('../services/vendor-credit.service.js')).listVendorCredits(c.tenantId, { limit: 100, offset: 0 }, c.companyId),
  },
  recurring: {
    name: 'Recurring Schedules', description: 'Active recurring transactions', scope: 'read', access: view('recurring'),
    read: async (c) => (await import('../services/recurring.service.js')).list(c.tenantId),
  },
  budgets: {
    name: 'Budgets', description: 'Budgets defined for this company', scope: 'read', access: view('budgets'),
    read: async (c) => (await import('../services/budget.service.js')).list(c.tenantId, { companyId: c.companyId }),
  },
  'checks/print-queue': {
    name: 'Check Print Queue', description: 'Checks queued for printing', scope: 'read', access: view('checks'),
    read: async (c) => (await import('../services/check.service.js')).getPrintQueue(c.tenantId, undefined, c.companyId),
  },
  reconciliations: {
    name: 'Reconciliations', description: 'Reconciliation history', scope: 'read', access: view('banking'),
    read: (c) => db.select().from(reconciliations).where(eq(reconciliations.tenantId, c.tenantId))
      .orderBy(desc(reconciliations.statementDate)).limit(50),
  },
  items: {
    name: 'Items', description: 'Products / services catalog', scope: 'read', access: view('items'),
    read: async (c) => (await import('../services/items.service.js')).list(c.tenantId, { limit: 200, offset: 0 }, c.companyId),
  },
  tags: {
    name: 'Tags', description: 'Tag groups and tags', scope: 'read', access: view('tags'),
    read: async (c) => {
      const { list, listGroups } = await import('../services/tags.service.js');
      const [tags, groups] = await Promise.all([list(c.tenantId), listGroups(c.tenantId)]);
      return { tags, groups };
    },
  },
  dashboard: {
    name: 'Dashboard', description: 'Dashboard summary', scope: 'read', access: view('dashboard'),
    read: async (c) => (await import('../services/dashboard.service.js')).getFinancialSnapshot(c.tenantId),
  },
};

const COMPANIES_URI = 'kisbooks://companies';

// ─── Errors ─────────────────────────────────────────────────────

interface Failure {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

const STATUS_CODES: Record<number, string> = {
  400: 'BAD_REQUEST', 401: 'AUTH_REQUIRED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 423: 'PERIOD_LOCKED', 429: 'RATE_LIMITED',
};

/** What went wrong, in words the caller may see. Anything unexpected is logged and reported without detail. */
function describeFailure(err: unknown): Failure {
  if (err instanceof McpToolError) return { code: err.code, message: err.message, details: err.details };
  if (err instanceof AppError) {
    return { code: err.code || STATUS_CODES[err.statusCode] || 'ERROR', message: err.message, details: err.details };
  }
  if (err instanceof ZodError) {
    const issues = err.issues.slice(0, 10).map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`);
    return { code: 'INVALID_PARAMS', message: issues.join('; ') };
  }
  // Older call sites signal with "CODE: message" (checkScope, services).
  const message = err instanceof Error ? err.message : '';
  const prefixed = /^([A-Z][A-Z0-9_]+): (.+)$/s.exec(message);
  if (prefixed) return { code: prefixed[1]!, message: prefixed[2]! };
  console.error('[MCP] unexpected error', err);
  return { code: 'INTERNAL_ERROR', message: 'Something went wrong on the server. Nothing was changed by this call unless an earlier result says so.' };
}

function failureText(f: Failure): string {
  return f.details ? `${f.code}: ${f.message}\n${JSON.stringify(f.details)}` : `${f.code}: ${f.message}`;
}

// ─── HTTP ───────────────────────────────────────────────────────

const originAllowlist = buildOriginAllowlist(env.CORS_ORIGIN);
const CLAUDE_ORIGINS = new Set(['https://claude.ai', 'https://claude.com']);

/**
 * The transport asks servers to refuse a browser Origin they do not expect
 * (DNS rebinding). Server-side clients send none. Allowed: this app's own
 * origins, Claude's, and a page on the caller's own machine (MCP Inspector).
 */
function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  if (CLAUDE_ORIGINS.has(origin) || originAllowlist.matches(origin)) return true;
  try {
    const url = new URL(origin);
    if (url.origin === new URL(env.PUBLIC_URL).origin) return true;
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  } catch {
    return false;
  }
}

type RpcId = string | number | null | undefined;

function rpcError(res: Response, status: number, id: RpcId, code: number, message: string, data?: Record<string, unknown>): void {
  res.status(status).json({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });
}

function rpcResult(res: Response, id: RpcId, result: unknown): void {
  res.status(200).json({ jsonrpc: '2.0', id, result });
}

function headerValue(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** GET and DELETE on /mcp: no SSE stream is offered and there is no session to end. */
export function handleMcpMethodNotAllowed(_req: Request, res: Response): void {
  res.setHeader('Allow', 'POST');
  res.status(405).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed. POST JSON-RPC messages to this endpoint.' } });
}

export async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  const start = Date.now();
  const body: unknown = req.body;
  const message = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as {
    id?: RpcId; method?: unknown; params?: Record<string, unknown>;
  };
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const ip = req.ip;
  const userAgent = headerValue(req, 'user-agent');

  if (!originAllowed(headerValue(req, 'origin'))) {
    rpcError(res, 403, id, -32000, 'Origin not allowed', { code: 'ORIGIN_DENIED' });
    return;
  }

  // System switch (Admin > MCP / API).
  const config = await db.query.mcpConfig.findFirst();
  if (config && !config.isEnabled) {
    rpcError(res, 403, id, -32000, 'MCP is disabled system-wide', { code: 'MCP_DISABLED' });
    return;
  }
  const oauthEnabled = config?.oauthEnabled === true;

  // Authenticate. A 401 carries the pointer an OAuth client follows to sign
  // in (RFC 9728); a 200 with an error body would never start that.
  let auth: McpAuthContext;
  try {
    const header = headerValue(req, 'authorization') ?? '';
    const token = /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : '';
    auth = await resolveMcpAuth(token, { oauthEnabled, resource: mcpResourceUrl() });
  } catch (err) {
    if (!(err instanceof McpAuthError)) throw err;
    if (!err.forbidden) {
      res.setHeader('WWW-Authenticate', oauthEnabled
        ? `Bearer resource_metadata="${protectedResourceMetadataUrl()}"`
        : 'Bearer');
    }
    rpcError(res, err.forbidden ? 403 : 401, id, -32000, err.message, { code: err.code });
    return;
  }

  const rateKey = auth.keyId || auth.userId;
  const rateCheck = checkRateLimit(rateKey, 60);
  if (!rateCheck.allowed) {
    await logMcpRequest({ auth, status: 'rate_limited', ipAddress: ip, userAgent });
    res.setHeader('Retry-After', String(rateCheck.retryAfterSeconds ?? 60));
    rpcError(res, 429, id, -32000, 'Rate limit exceeded', { code: 'RATE_LIMITED', retry_after_seconds: rateCheck.retryAfterSeconds });
    return;
  }

  if (Array.isArray(body) || !method) {
    // A client's reply to a server request (this server sends none) is
    // acknowledged like a notification; anything else is not a message.
    if (!Array.isArray(body) && ('result' in message || 'error' in message)) {
      res.status(202).end();
      return;
    }
    rpcError(res, 400, id, -32600, 'Send one JSON-RPC request object per POST');
    return;
  }
  const version = headerValue(req, 'mcp-protocol-version');
  if (version && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    rpcError(res, 400, id, -32600, `Unsupported MCP-Protocol-Version: ${version}`, { supported: SUPPORTED_PROTOCOL_VERSIONS });
    return;
  }

  // A notification (no id) or a client's response is acknowledged, never answered.
  if (id === undefined || id === null) {
    res.status(202).end();
    return;
  }

  const session = sessionFor(auth, headerValue(req, 'mcp-session-id'));

  try {
    switch (method) {
      case 'initialize': {
        const requested = typeof message.params?.['protocolVersion'] === 'string' ? message.params['protocolVersion'] : '';
        const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
          ? requested
          : SUPPORTED_PROTOCOL_VERSIONS[0];
        // Names the connection so two chats on one key each keep their own
        // active client (context.ts). Signed, so only an id issued here to
        // this caller counts. Nothing else is held for it.
        res.setHeader('Mcp-Session-Id', issueSessionId(auth));
        rpcResult(res, id, {
          protocolVersion,
          serverInfo: SERVER_INFO,
          capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
          instructions: INSTRUCTIONS,
        });
        return;
      }

      case 'ping':
        rpcResult(res, id, {});
        return;

      case 'tools/list':
        rpcResult(res, id, {
          tools: listTools().map((t) => ({
            name: t.name, title: t.annotations.title, description: t.description,
            inputSchema: t.inputSchema, annotations: t.annotations,
          })),
        });
        return;

      case 'tools/call':
        await callTool(req, res, { id, auth, session, params: message.params ?? {}, start, ip, userAgent });
        return;

      case 'resources/list':
        rpcResult(res, id, {
          resources: [{ uri: COMPANIES_URI, name: 'Companies', description: 'Client companies you can work in', mimeType: 'application/json' }],
        });
        return;

      case 'resources/templates/list':
        rpcResult(res, id, {
          resourceTemplates: Object.entries(COMPANY_RESOURCES).map(([path, def]) => ({
            uriTemplate: `kisbooks://company/{company_id}/${path}`, name: def.name, description: def.description, mimeType: 'application/json',
          })),
        });
        return;

      case 'resources/read':
        await readResource(res, { id, auth, session, params: message.params ?? {}, start, ip, userAgent });
        return;

      default:
        rpcError(res, 200, id, -32601, `Method not supported: ${method}`);
    }
  } catch (err) {
    // Anything that escapes the per-call handling above.
    const failure = describeFailure(err);
    await logMcpRequest({ auth, status: 'error', errorCode: failure.code, ipAddress: ip, userAgent, durationMs: Date.now() - start }).catch(() => {});
    rpcError(res, 200, id, -32603, failureText(failure), { code: failure.code });
  }
}

interface CallEnv {
  id: RpcId;
  auth: McpAuthContext;
  session: McpSession;
  params: Record<string, unknown>;
  start: number;
  ip: string | undefined;
  userAgent: string | undefined;
}

/** The result as JSON text. A value that cannot be serialized still reports that the call ran. */
function safeJson(result: unknown): string {
  try {
    return JSON.stringify(result ?? null);
  } catch {
    return JSON.stringify({ done: true, note: 'The call completed, but its result could not be shown.' });
  }
}

async function callTool(_req: Request, res: Response, call: CallEnv): Promise<void> {
  const { id, auth, session } = call;
  const toolName = typeof call.params['name'] === 'string' ? call.params['name'] : '';
  const tool = getTool(toolName);
  if (!tool) {
    rpcError(res, 200, id, -32602, `Unknown tool: ${toolName}`);
    return;
  }

  let client: McpClientContext | undefined;
  let args: Record<string, unknown> = {};
  try {
    args = tool.input.parse(boundedParams(call.params['arguments'])) as Record<string, unknown>;

    let result: unknown;
    if (tool.kind === 'session') {
      result = await tool.handler(args, { auth, session });
    } else if (tool.kind === 'user') {
      checkScope(auth, tool.scope);
      result = await tool.handler(args, { auth, session });
    } else {
      checkScope(auth, tool.scope);
      client = await resolveClient(auth, session, args['company_id'] as string | undefined, {
        write: tool.access.action !== 'read',
      });
      assertAccess(client, tool.access);
      const ctx: ToolContext = { ...client, auth, userId: auth.userId };
      result = await tool.handler(args, ctx);
    }

    const text = safeJson(result);
    // The call has already done its work. A log row that fails to write
    // must not turn it into a reported failure: the caller would be told
    // nothing changed, and would post the same thing again.
    await logMcpRequest({
      auth, toolName, companyId: client?.companyId, parameters: args, status: 'success',
      responseSummary: text.slice(0, 200), durationMs: Date.now() - call.start, ipAddress: call.ip, userAgent: call.userAgent,
    }).catch((logErr: unknown) => { console.error('[mcp] request log failed after a successful call', toolName, logErr); });
    rpcResult(res, id, {
      content: [
        { type: 'text', text },
        ...(client ? [{ type: 'text', text: `Client: ${client.companyName} (company_id ${client.companyId})` }] : []),
      ],
    });
  } catch (err) {
    // A failed call is a result the model can read and act on, not a
    // transport error (which a client would only show as "tool failed").
    const failure = describeFailure(err);
    await logMcpRequest({
      auth, toolName, companyId: client?.companyId, parameters: args, status: 'error', errorCode: failure.code,
      durationMs: Date.now() - call.start, ipAddress: call.ip, userAgent: call.userAgent,
    }).catch(() => {});
    rpcResult(res, id, {
      isError: true,
      content: [
        { type: 'text', text: failureText(failure) },
        ...(client ? [{ type: 'text', text: `Client: ${client.companyName} (company_id ${client.companyId})` }] : []),
      ],
    });
  }
}

async function readResource(res: Response, call: CallEnv): Promise<void> {
  const { id, auth, session } = call;
  const uri = typeof call.params['uri'] === 'string' ? call.params['uri'] : '';
  if (!uri) {
    rpcError(res, 200, id, -32602, 'URI required');
    return;
  }

  let client: McpClientContext | undefined;
  try {
    let data: unknown;
    if (uri === COMPANIES_URI) {
      const all = await getUserCompanies(auth.userId);
      data = all
        .filter((c) => !auth.allowedCompanies || auth.allowedCompanies.includes(c.id))
        .map((c) => ({ id: c.id, name: c.name, role: c.role, mcpEnabled: c.mcpEnabled }));
    } else {
      const match = /^kisbooks:\/\/company\/([^/]+)\/(.+)$/.exec(uri);
      const def = match ? COMPANY_RESOURCES[match[2]!] : undefined;
      if (!match || !def) {
        rpcError(res, 200, id, -32002, `Resource not found: ${uri}`, { uri });
        return;
      }
      checkScope(auth, def.scope);
      client = await resolveClient(auth, session, match[1]!);
      assertAccess(client, def.access);
      data = await def.read(client);
    }
    await logMcpRequest({
      auth, resourceUri: uri, companyId: client?.companyId, status: 'success',
      durationMs: Date.now() - call.start, ipAddress: call.ip, userAgent: call.userAgent,
    });
    rpcResult(res, id, { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data) }] });
  } catch (err) {
    const failure = describeFailure(err);
    await logMcpRequest({
      auth, resourceUri: uri, companyId: client?.companyId, status: 'error', errorCode: failure.code,
      durationMs: Date.now() - call.start, ipAddress: call.ip, userAgent: call.userAgent,
    }).catch(() => {});
    rpcError(res, 200, id, -32603, failureText(failure), { code: failure.code });
  }
}
