// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Route classes (U-288, route-classes-v1): every operation has an x-lan class,
// every write an x-stale class, and the request-time lookup agrees with the
// spec. Runs without a database (like openapi.test.ts).

import { describe, it, expect, beforeAll, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { loadEngineSpec } from '../openapi/engine-spec.js';
import {
  isMutating,
  lanClassOf,
  staleClassOf,
  STALE_CLASSES,
  STALE_EXEMPT_RECORD_WRITES,
  unusedRules,
} from './route-classes.js';

type Operation = { security?: unknown[]; 'x-lan'?: string; 'x-stale'?: string };
type Op = { method: string; path: string; op: Operation };

let ops: Op[] = [];
let desktopOps: Array<{ method: string; path: string }> = [];

const SAMPLE = '0b6c2a4e-6f6e-4c1d-8a37-6c1f4d8e9a01';
const concrete = (p: string) => p.replace(/\{[^}]+\}/g, SAMPLE);
const key = (o: { method: string; path: string }) => `${o.method.toUpperCase()} ${o.path}`;

/** Records the routes app.ts mounts in desktop mode (the spec is built in server mode). */
async function desktopRoutes(): Promise<Array<{ method: string; path: string }>> {
  vi.resetModules();
  const profile = await import('./profile.js');
  profile.loadDesktopProfile({
    CL_MODE: 'desktop',
    CL_TOKEN: 'routeclasses_' + 'x'.repeat(40),
    CL_BIND: '127.0.0.1:0',
    CL_DATA_DIR: path.join(os.tmpdir(), 'cl-route-classes-test'),
  });
  const { installRecorder } = await import('../openapi/recorder.js');
  const recorder = installRecorder();
  try {
    const { app } = await import('../app.js');
    return recorder.collect(app).routes.map((r) => ({ method: r.method, path: r.path }));
  } finally {
    recorder.uninstall();
    profile._resetDesktopProfileForTests();
  }
}

beforeAll(async () => {
  const spec = await loadEngineSpec();
  const paths = spec.doc['paths'] as Record<string, Record<string, Operation>>;
  ops = Object.entries(paths).flatMap(([p, byMethod]) =>
    Object.entries(byMethod).map(([method, op]) => ({ method, path: p, op })),
  );
  desktopOps = await desktopRoutes();
}, 240_000);

describe('x-lan', () => {
  it('every operation carries x-lan, equal to the request-time lookup', () => {
    const missing = ops.filter((o) => o.op['x-lan'] !== 'workstation' && o.op['x-lan'] !== 'host').map(key);
    expect(missing).toEqual([]);
    for (const o of ops) {
      expect(lanClassOf(o.method, o.path), key(o)).toBe(o.op['x-lan']);
      // A concrete request path resolves to the same class as its template.
      expect(lanClassOf(o.method, concrete(o.path)), key(o)).toBe(o.op['x-lan']);
    }
  });

  it('is default deny: an unknown route is host-only', () => {
    expect(lanClassOf('GET', '/api/v1/no-such-family')).toBe('host');
    expect(lanClassOf('POST', '/api/v1/no-such-family/x')).toBe('host');
    expect(lanClassOf('GET', '/totally/else')).toBe('host');
  });

  it('desktop routes: first run, recovery and secret writes are host-only; info is open to workstations', () => {
    const desktop = desktopOps.filter((o) => o.path.startsWith('/api/v1/desktop/'));
    expect(desktop.length).toBeGreaterThan(4);
    for (const o of desktop) {
      const allowed = ['GET /api/v1/desktop/info', 'GET /api/v1/desktop/session-secrets'].includes(key(o));
      expect(lanClassOf(o.method, o.path), key(o)).toBe(allowed ? 'workstation' : 'host');
    }
    for (const k of ['POST /api/v1/desktop/initialize', 'POST /api/v1/desktop/recover-password',
      'PUT /api/v1/desktop/session-secrets', 'DELETE /api/v1/desktop/session-secrets/{name}']) {
      expect(desktopOps.map(key), k).toContain(k);
    }
    // Every route below a company (archives, totals, the planned safe delete) is host-only.
    expect(lanClassOf('POST', '/api/v1/tenants/{id}/delete')).toBe('host');
    expect(lanClassOf('PATCH', '/api/v1/tenants/{id}')).toBe('workstation');
  });

  it('backup-first and host-path operations are host-only (Q-P33y)', () => {
    const hostOnly = [
      'POST /api/v1/tenant-archives/import',
      'GET /api/v1/tenant-archives/jobs/{jobId}',
      'GET /api/v1/tenant-archives/{fileName}/download',
      'POST /api/v1/tenants/{id}/archives',
      'GET /api/v1/tenants/{id}/verification-totals',
      'POST /api/v1/tenants',
      'POST /api/v1/imports/upload',
      'POST /api/v1/imports/{id}/commit',
      'POST /api/v1/imports/batches/{id}/commit',
      'POST /api/v1/imports/batches/{id}/undo',
      'POST /api/v1/payroll-import/sessions/{id}/post',
      'POST /api/v1/payroll-import/sessions/{id}/checks/post',
      'POST /api/v1/payroll-import/sessions/{id}/check-register/post',
      'POST /api/v1/payroll-import/sessions/{id}/reverse',
      'POST /api/v1/company/create',
      'DELETE /api/v1/company/{id}',
      'PUT /api/v1/ai/admin/config',
      'PUT /api/v1/company/smtp',
      'POST /api/v1/api-keys',
    ];
    const known = new Set(ops.map(key));
    for (const k of hostOnly) {
      expect(known.has(k), `${k} is not in the spec`).toBe(true);
      const [m, p] = k.split(' ') as [string, string];
      expect(lanClassOf(m, p), k).toBe('host');
    }
  });

  it('every workstation route without a session is on the named list (B1)', () => {
    const OPEN = new Set([
      'GET /health', 'GET /ping', 'GET /api/health', 'GET /api/ping', 'GET /api/v1/health', 'GET /api/v1/ping',
      'POST /api/v1/auth/login', 'POST /api/v1/auth/refresh', 'POST /api/v1/auth/logout', 'GET /api/v1/auth/methods',
      'POST /api/v1/auth/passkeys/login/options', 'POST /api/v1/auth/passkeys/login/verify',
      'POST /api/v1/auth/tfa/send-code', 'POST /api/v1/auth/tfa/verify', 'POST /api/v1/auth/tfa/verify-recovery',
      'GET /api/v1/coa-templates/options', 'GET /api/v1/fs-fonts/{file}',
    ]);
    const open = ops.filter((o) => o.op['x-lan'] === 'workstation' && !o.op.security).map(key);
    expect(open.filter((k) => !OPEN.has(k))).toEqual([]);
  });
});

describe('x-stale', () => {
  it('every write carries a known x-stale class; reads carry none', () => {
    for (const o of ops) {
      if (isMutating(o.method)) {
        expect(STALE_CLASSES, key(o)).toContain(o.op['x-stale']);
        expect(staleClassOf(o.method, concrete(o.path)), key(o)).toBe(o.op['x-stale']);
      } else {
        expect(o.op['x-stale'], key(o)).toBeUndefined();
      }
    }
  });

  it('every workstation write in desktop mode is classified by a rule', () => {
    const unclassified = desktopOps
      .filter((o) => isMutating(o.method) && staleClassOf(o.method, o.path) === null)
      .map(key);
    expect(unclassified).toEqual([]);
  });

  it('a workstation record edit is stale-checked or state-guarded unless exempt with a reason', () => {
    const offenders = ops
      .filter((o) => o.op['x-lan'] === 'workstation' && ['put', 'patch', 'delete'].includes(o.method))
      .filter((o) => o.path.includes('{'))
      .filter((o) => o.op['x-stale'] === 'n-a' || o.op['x-stale'] === 'create')
      .map(key)
      .filter((k) => !(k in STALE_EXEMPT_RECORD_WRITES));
    expect(offenders).toEqual([]);
    // No stale exemptions: each names a workstation record write that is n-a or create.
    const byKey = new Map(ops.map((o) => [key(o), o.op]));
    for (const k of Object.keys(STALE_EXEMPT_RECORD_WRITES)) {
      const op = byKey.get(k);
      expect(op, `${k} is not in the spec`).toBeDefined();
      expect(op!['x-lan'], k).toBe('workstation');
      expect(['n-a', 'create'], k).toContain(op!['x-stale']);
    }
  });

  it('the core money records are stale-checked', () => {
    for (const k of [
      'PUT /api/v1/transactions/{id}', 'DELETE /api/v1/transactions/{id}', 'POST /api/v1/transactions/{id}/void',
      'PUT /api/v1/checks/{id}', 'PUT /api/v1/contacts/{id}', 'PUT /api/v1/accounts/{id}', 'PUT /api/v1/tags/{id}',
      'PUT /api/v1/invoices/{id}', 'PUT /api/v1/bills/{id}', 'PUT /api/v1/items/{id}',
    ]) {
      const [m, p] = k.split(' ') as [string, string];
      expect(staleClassOf(m, p), k).toBe('stale(updatedAt)');
    }
    expect(staleClassOf('PUT', '/api/v1/budgets/{id}')).toBe('stale(version)');
    expect(staleClassOf('PUT', '/api/v1/recurring/{id}')).toBe('stale(schedule)');
    expect(staleClassOf('POST', '/api/v1/transactions/bulk-update')).toBe('bulk');
    expect(staleClassOf('POST', '/api/v1/payments/{id}/apply')).toBe('state-guarded');
  });
});

describe('the rule table', () => {
  it('has no rule that matches nothing', () => {
    expect(unusedRules([...ops, ...desktopOps])).toEqual([]);
  });
});
