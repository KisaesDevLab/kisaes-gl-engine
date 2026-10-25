// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * E20 (U-18): the idempotency-v1 route set in the OpenAPI document. Exactly
 * these operations carry the Idempotency-Key header parameter and
 * `x-idempotency: true` (clients upgrade their retry behaviour per route on
 * it), and the capability is advertised. Needs no database.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { loadEngineSpec } from './engine-spec.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

type Param = { name: string; in: string; required?: boolean; schema?: { pattern?: string } };
type Operation = { parameters?: Param[]; 'x-idempotency'?: boolean };
type Paths = Record<string, Record<string, Operation>>;

/** The idempotency-v1 set (append-only under a new name). */
export const IDEMPOTENCY_V1_ROUTES = [
  'post /api/v1/transactions',
  'put /api/v1/transactions/{id}',
  'post /api/v1/transactions/{id}/void',
  'delete /api/v1/transactions/{id}',
  'post /api/v1/checks',
  'put /api/v1/checks/{id}',
  'post /api/v1/invoices',
  'post /api/v1/bills',
  'post /api/v1/daily-sales/entries',
  'post /api/v1/daily-sales/entries/{id}/post',
  'post /api/v1/daily-sales/entries/{id}/void',
  'post /api/v1/templates',
  'post /api/v1/templates/from-transaction',
  'post /api/v1/templates/{id}/enter',
  'post /api/v1/templates/{id}/occurrences/{date}/skip',
  'post /api/v1/templates/{id}/occurrences/{date}/resolve',
  'post /api/v1/accounts',
  'post /api/v1/contacts',
  'post /api/v1/items',
  'post /api/v1/tags',
].sort();

let paths: Paths;

beforeAll(async () => {
  const spec = await loadEngineSpec();
  paths = spec.doc['paths'] as Paths;
}, 120_000);

describe('idempotency-v1 in openapi.json', () => {
  it('exactly the route set carries x-idempotency and the Idempotency-Key header', () => {
    const marked: string[] = [];
    const withHeader: string[] = [];
    for (const [path, ops] of Object.entries(paths)) {
      for (const [method, op] of Object.entries(ops)) {
        if (op['x-idempotency'] === true) marked.push(`${method} ${path}`);
        const h = (op.parameters ?? []).find((p) => p.in === 'header' && p.name === 'Idempotency-Key');
        if (h) {
          withHeader.push(`${method} ${path}`);
          expect(h.required).toBe(false);
          expect(h.schema?.pattern).toBe('^[A-Za-z0-9_-]{16,64}$');
        }
      }
    }
    expect(marked.sort()).toEqual(IDEMPOTENCY_V1_ROUTES);
    expect(withHeader.sort()).toEqual(IDEMPOTENCY_V1_ROUTES);
  });

  it('/batch/save and tenant creation are not in the set', () => {
    expect(paths['/api/v1/batch/save']?.['post']?.['x-idempotency']).toBeUndefined();
    expect(paths['/api/v1/auth/create-tenant']?.['post']?.['x-idempotency']).toBeUndefined();
    expect(paths['/api/v1/tenants']?.['post']?.['x-idempotency']).toBeUndefined();
  });

  it('the capability is advertised', () => {
    expect(DESKTOP_CAPABILITIES).toContain('idempotency-v1');
    expect(DESKTOP_CAPABILITIES).toContain('batch-idempotent-v1');
  });
});
