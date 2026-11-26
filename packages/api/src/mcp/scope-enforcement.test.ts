// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

import { describe, it, expect } from 'vitest';
import { RESOURCE_KEYS } from '@kis-books/shared';
import './tools.js';
import { listTools } from './registry.js';

// Regression guard for MCP tool authorization.
//
// The dispatcher (server.ts) checks, before a handler runs, the token scope
// and the client-level permission each tool DECLARES. So the drift risk is
// a tool declared without them, or with the wrong kind. This reads the
// registry itself: a future tool that declares nothing cannot be registered
// as a company tool at all (the type requires both), and the checks below
// catch the remaining ways to get it wrong.

// Tools that need no scope: they only show or switch the caller's own
// context and cause nothing the bearer is not already allowed to do.
const SESSION_TOOLS = ['get_active_company', 'list_companies', 'set_active_company'];
// Tools that act on the caller's own bank connections, not in one client.
const USER_TOOLS = ['get_bank_connections', 'sync_bank_connection'];
// The only tool that needs membership of the client and nothing more.
const MEMBERSHIP_ONLY = ['get_company_info'];

const SCOPES = ['read', 'write', 'reports', 'banking', 'invoicing'];

describe('MCP tool registry', () => {
  const tools = listTools();

  it('registers every tool', () => {
    // Keep in step with the tool count; it should only ever grow.
    expect(tools.length).toBeGreaterThanOrEqual(89);
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
  });

  it('only the listed tools run without a scope or outside a client', () => {
    expect(tools.filter((t) => t.kind === 'session').map((t) => t.name).sort()).toEqual(SESSION_TOOLS);
    expect(tools.filter((t) => t.kind === 'user').map((t) => t.name).sort()).toEqual(USER_TOOLS);
  });

  it('every company tool declares a scope and the permission it needs in the client\'s books', () => {
    const offenders: string[] = [];
    for (const t of tools) {
      if (t.kind === 'session') continue;
      if (!SCOPES.includes(t.scope)) offenders.push(`${t.name}: scope`);
      if (t.kind !== 'company') continue;
      if (t.access.resources.some((r) => !RESOURCE_KEYS.includes(r))) offenders.push(`${t.name}: unknown resource`);
      if (t.access.resources.length === 0 && !MEMBERSHIP_ONLY.includes(t.name)) offenders.push(`${t.name}: no resource`);
      // A tool that changes something needs full access, and says so to the client.
      if (t.annotations.readOnlyHint !== (t.access.action === 'read')) offenders.push(`${t.name}: read/write mismatch`);
    }
    expect(offenders).toEqual([]);
  });

  it('a read-scoped token can never reach a tool that writes', () => {
    const writesOnReadScope = tools
      .filter((t) => t.kind === 'company' && t.access.action !== 'read' && (t.scope === 'read' || t.scope === 'reports'))
      .map((t) => t.name);
    expect(writesOnReadScope).toEqual([]);
  });

  it('publishes a valid JSON Schema for every tool', () => {
    const problems: string[] = [];
    const check = (name: string, schema: unknown, path: string) => {
      if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
        problems.push(`${name} ${path}: not a schema object`);
        return;
      }
      const node = schema as Record<string, unknown>;
      const props = node['properties'];
      if (props !== undefined) {
        if (typeof props !== 'object' || props === null) problems.push(`${name} ${path}: properties`);
        else for (const [key, value] of Object.entries(props)) check(name, value, `${path}.${key}`);
      }
      if (node['items'] !== undefined) check(name, node['items'], `${path}[]`);
      for (const key of ['anyOf', 'oneOf', 'allOf']) {
        const list = node[key];
        if (Array.isArray(list)) list.forEach((s, i) => check(name, s, `${path}.${key}${i}`));
      }
    };
    for (const t of tools) {
      expect(t.inputSchema['type'], t.name).toBe('object');
      expect(t.inputSchema['$schema'], t.name).toBeUndefined();
      expect(t.name).toMatch(/^[a-z0-9_]{1,64}$/);
      expect(t.annotations.title.length, t.name).toBeGreaterThan(0);
      check(t.name, t.inputSchema, '$');
    }
    expect(problems).toEqual([]);
  });

  it('accepts string-only clients: a JSON-encoded list, a numeric string, "true"', () => {
    const bills = tools.find((t) => t.name === 'list_bills')!;
    expect(bills.input.parse({ limit: '25', overdue_only: 'true', contact_id: '' })).toEqual({ limit: 25, overdue_only: true });
    const tag = tools.find((t) => t.name === 'tag_transaction')!;
    const id = '11111111-1111-4111-8111-111111111111';
    expect(tag.input.parse({ transaction_id: id, tag_ids: JSON.stringify([id]) })).toEqual({ transaction_id: id, tag_ids: [id] });
    expect(() => tag.input.parse({ transaction_id: 'not-an-id', tag_ids: [] })).toThrow();
  });
});
