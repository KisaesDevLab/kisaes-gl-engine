// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// The MCP tool registry. A tool is its input schema (Zod: validated on every
// call and published to clients as JSON Schema), the token scope it needs,
// and the permission the caller must hold in the client's books. The
// dispatcher in server.ts enforces all three before a handler runs, so a
// handler never checks access itself and a new tool cannot forget to.

import type { McpSession } from './context.js';
import { z, type ZodRawShape, type ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type {
  EffectivePermissions, McpAuthContext, McpScope, PermissionAction, ResourceKey,
} from '@kis-books/shared';

/** A failure the caller can act on. `code` is stable; clients and tests match on it. */
export class McpToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'McpToolError';
  }
}

/** The client's books a company tool runs in, already checked for access. */
export interface McpClientContext {
  companyId: string;
  companyName: string;
  tenantId: string;
  /** The caller's role in this client's tenant. */
  role: string;
  isSuperAdmin: boolean;
  permissions: EffectivePermissions;
}

export interface ToolContext extends McpClientContext {
  auth: McpAuthContext;
  userId: string;
}

export interface SessionContext {
  auth: McpAuthContext;
  /** The connection, which keys its remembered client (see context.ts). */
  session: McpSession;
}

/** The permission a tool needs in the client's books; every listed resource is required. */
export interface ToolAccess {
  resources: readonly ResourceKey[];
  action: PermissionAction;
}

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

interface ToolBase {
  name: string;
  description: string;
  input: z.ZodObject<ZodRawShape>;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
}

export interface CompanyTool extends ToolBase {
  kind: 'company';
  scope: McpScope;
  access: ToolAccess;
  handler: (params: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

/** Tools about the connection itself (which client is active). No company, no scope. */
export interface SessionTool extends ToolBase {
  kind: 'session';
  handler: (params: Record<string, unknown>, ctx: SessionContext) => Promise<unknown>;
}

/** Tools that act across the caller's own bank connections rather than in one client. */
export interface UserTool extends ToolBase {
  kind: 'user';
  scope: McpScope;
  handler: (params: Record<string, unknown>, ctx: SessionContext) => Promise<unknown>;
}

export type ToolDef = CompanyTool | SessionTool | UserTool;

const tools = new Map<string, ToolDef>();

export function getTool(name: string): ToolDef | undefined {
  return tools.get(name);
}

export function listTools(): ToolDef[] {
  return Array.from(tools.values());
}

// ─── Input helpers ──────────────────────────────────────────────
//
// Some MCP clients send every argument as a string. These accept that form
// and the typed one, and publish the typed one.

const emptyToUndefined = (v: unknown) => (v === '' || v === null ? undefined : v);

export const id = (what: string) => z.string().uuid().describe(what);
/** Optional id; an empty string counts as absent. */
export const optId = (what: string) => z.preprocess(emptyToUndefined, z.string().uuid().optional()).describe(what);
export const date = (what: string) => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').describe(`${what} (YYYY-MM-DD)`);
export const optDate = (what: string) =>
  z.preprocess(emptyToUndefined, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional()).describe(`${what} (YYYY-MM-DD)`);
/** A decimal amount as a string, e.g. "125.00". A JSON number is accepted and converted. */
export const money = (what: string) =>
  z.preprocess((v) => (typeof v === 'number' ? String(v) : v), z.string().regex(/^-?\d+(\.\d{1,4})?$/, 'Use a decimal string such as "125.00"'))
    .describe(`${what} (decimal string, e.g. "125.00")`);
export const text = (what: string) => z.string().describe(what);
export const optText = (what: string) => z.preprocess((v) => (v === null ? undefined : v), z.string().optional()).describe(what);
export const optInt = (what: string, max: number) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : emptyToUndefined(v)), z.number().int().min(1).max(max).optional())
    .describe(what);
export const optBool = (what: string) =>
  z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : emptyToUndefined(v)), z.boolean().optional()).describe(what);
/** An array argument; a JSON-encoded string of the array is accepted too. */
export function jsonArray<T extends ZodTypeAny>(inner: z.ZodArray<T> | z.ZodEffects<z.ZodArray<T>>, what: string) {
  return z.preprocess((v) => {
    if (typeof v !== 'string') return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }, inner).describe(what);
}

const COMPANY_ID = optId(
  'The client company to act on (an id from list_companies). Omit to use the company set with set_active_company; a call that changes data should always pass it.',
);

function toInputSchema(schema: z.ZodObject<ZodRawShape>): Record<string, unknown> {
  const json = zodToJsonSchema(schema, { $refStrategy: 'none', target: 'jsonSchema7' }) as Record<string, unknown>;
  delete json['$schema'];
  return json;
}

function add(def: ToolDef): void {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(def.name)) throw new Error(`MCP tool name not allowed: ${def.name}`);
  if (tools.has(def.name)) throw new Error(`MCP tool registered twice: ${def.name}`);
  tools.set(def.name, def);
}

interface CompanyToolSpec<S extends ZodRawShape> {
  title: string;
  description: string;
  input: S;
  scope: McpScope;
  /** Permission resource(s) in the client's books, as the REST routers gate them. */
  resource: ResourceKey | readonly ResourceKey[];
  /** 'read' needs view access; 'write' needs full access. */
  mode: 'read' | 'write';
  /** A write that removes or reverses something (void, undo, discard). */
  destructive?: boolean;
  idempotent?: boolean;
  /** Reaches outside the books (sends email, calls the bank). */
  openWorld?: boolean;
  handler: (params: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<unknown>;
}

export function companyTool<S extends ZodRawShape>(name: string, spec: CompanyToolSpec<S>): void {
  const input = z.object({ company_id: COMPANY_ID, ...spec.input }) as unknown as z.ZodObject<ZodRawShape>;
  const readOnly = spec.mode === 'read';
  add({
    kind: 'company',
    name,
    description: spec.description,
    input,
    inputSchema: toInputSchema(input),
    annotations: {
      title: spec.title,
      readOnlyHint: readOnly,
      ...(readOnly ? {} : { destructiveHint: !!spec.destructive, idempotentHint: !!spec.idempotent }),
      openWorldHint: !!spec.openWorld,
    },
    scope: spec.scope,
    access: {
      resources: typeof spec.resource === 'string' ? [spec.resource] : spec.resource,
      action: readOnly ? 'read' : 'update',
    },
    handler: spec.handler as CompanyTool['handler'],
  });
}

interface SessionToolSpec<S extends ZodRawShape> {
  title: string;
  description: string;
  input: S;
  readOnly: boolean;
  handler: (params: z.infer<z.ZodObject<S>>, ctx: SessionContext) => Promise<unknown>;
}

export function sessionTool<S extends ZodRawShape>(name: string, spec: SessionToolSpec<S>): void {
  const input = z.object(spec.input) as unknown as z.ZodObject<ZodRawShape>;
  add({
    kind: 'session',
    name,
    description: spec.description,
    input,
    inputSchema: toInputSchema(input),
    annotations: {
      title: spec.title,
      readOnlyHint: spec.readOnly,
      ...(spec.readOnly ? {} : { destructiveHint: false, idempotentHint: true }),
      openWorldHint: false,
    },
    handler: spec.handler as SessionTool['handler'],
  });
}

interface UserToolSpec<S extends ZodRawShape> extends SessionToolSpec<S> {
  scope: McpScope;
  openWorld?: boolean;
}

export function userTool<S extends ZodRawShape>(name: string, spec: UserToolSpec<S>): void {
  const input = z.object(spec.input) as unknown as z.ZodObject<ZodRawShape>;
  add({
    kind: 'user',
    name,
    description: spec.description,
    input,
    inputSchema: toInputSchema(input),
    annotations: {
      title: spec.title,
      readOnlyHint: spec.readOnly,
      ...(spec.readOnly ? {} : { destructiveHint: false, idempotentHint: true }),
      openWorldHint: !!spec.openWorld,
    },
    scope: spec.scope,
    handler: spec.handler as UserTool['handler'],
  });
}
