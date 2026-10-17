// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * OpenAPI export tests against the real app (U-04).
 *
 * Importing app.ts opens no Postgres or Redis connection, and the live
 * smoke below only sends unauthenticated requests to operations whose
 * first route-specific middleware is authenticate(), which rejects them
 * before any handler or database access. So this file runs without a
 * database or Redis (set SKIP_TEST_MIGRATIONS=1 when none is available).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Validator } from '@seriousme/openapi-schema-validator';
import { loadEngineSpec, type EngineSpec } from './engine-spec.js';
import { countStackRoutes } from './recorder.js';
import { stableStringify } from './generate.js';
import { SKIP_TABLE } from './skip-table.js';

type Operation = { security?: Array<Record<string, unknown>> };
type Paths = Record<string, Record<string, Operation>>;

const API_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const REPO_ROOT = resolve(API_ROOT, '../..');
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

let spec: EngineSpec;
let paths: Paths;

beforeAll(async () => {
  spec = await loadEngineSpec();
  paths = spec.doc['paths'] as Paths;
}, 120_000);

function operations(): Array<{ method: string; path: string; op: Operation }> {
  return Object.entries(paths).flatMap(([path, ops]) =>
    Object.entries(ops).map(([method, op]) => ({ method, path, op })),
  );
}

function concrete(path: string): string {
  return path.replace(/\{[^}]+\}/g, ZERO_UUID);
}

describe('openapi.json validity', () => {
  it('is a valid OpenAPI 3.1 document', async () => {
    const validator = new Validator();
    const result = await validator.validate(spec.doc as unknown as Parameters<Validator['validate']>[0]);
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
    expect(validator.version).toBe('3.1');
  });

  it('matches the committed openapi.json (run `npm run openapi:export` if this fails)', () => {
    const committed = readFileSync(join(REPO_ROOT, 'openapi.json'), 'utf8').replace(/\r\n/g, '\n');
    expect(stableStringify(spec.doc) === committed).toBe(true);
  });

  it('keeps decimal-string money fields as strings', () => {
    const body = (paths['/api/v1/invoices']!['post'] as unknown as {
      requestBody: { content: { 'application/json': { schema: { properties: { lines: { items: { properties: Record<string, { type: string }> } } } } } } };
    }).requestBody.content['application/json'].schema.properties.lines.items.properties;
    expect(body['unitPrice']!.type).toBe('string');
    expect(body['quantity']!.type).toBe('string');
  });

  it('marks authenticated operations with BearerAuth and leaves public ones open', () => {
    expect(paths['/api/v1/accounts']!['get']!.security).toEqual([{ BearerAuth: [] }, { ApiKeyAuth: [] }]);
    expect(paths['/api/v1/auth/login']!['post']!.security).toBeUndefined();
    expect(paths['/health']!['get']!.security).toBeUndefined();
  });
});

describe('route coverage', () => {
  it('documents every recorded route', () => {
    const missing = spec.collection.routes
      .filter((r) => !paths[r.path]?.[r.method])
      .map((r) => `${r.method.toUpperCase()} ${r.path}`);
    expect(missing).toEqual([]);
    expect(operations().length).toBe(spec.collection.routes.length);
  });

  it('accounts for every route layer Express registered (independent stack walk)', () => {
    // Method-level skips are route layers; RegExp USE/ROUTE skips are not counted per method.
    const methodSkips = spec.collection.skipped.filter((s) => !/^(USE|ROUTE) /.test(s.key)).length;
    expect(countStackRoutes(spec.app)).toBe(
      spec.collection.routes.length + spec.collection.shadowed.length + methodSkips,
    );
  });

  it('lists every skipped registration in the skip table, and nothing stale', () => {
    expect(spec.collection.skipped.map((s) => s.key).sort()).toEqual(Object.keys(SKIP_TABLE).sort());
  });

  it("resolves every documented operation through Express's own matcher", () => {
    type Layer = {
      route?: { _handles_method(m: string): boolean };
      handle: unknown;
      match(path: string): boolean;
      path?: string;
    };
    const root = (spec.app as unknown as { _router: { stack: Layer[] } })._router.stack;
    const resolves = (stack: Layer[], url: string, method: string): boolean => {
      for (const layer of stack) {
        if (!layer.match(url)) continue;
        if (layer.route) {
          if (layer.route._handles_method(method)) return true;
          continue;
        }
        const inner = (layer.handle as { stack?: unknown }).stack;
        if (Array.isArray(inner)) {
          const rest = url.slice((layer.path ?? '').length) || '/';
          if (resolves(inner as Layer[], rest.startsWith('/') ? rest : `/${rest}`, method)) return true;
        }
      }
      return false;
    };
    const unresolved = operations()
      .filter(({ method, path }) => !resolves(root, concrete(path), method))
      .map(({ method, path }) => `${method.toUpperCase()} ${path}`);
    expect(unresolved).toEqual([]);
  });

  it('reaches authenticated operations over HTTP (401, never the catch-all 404)', async () => {
    const { authenticate } = await import('../middleware/auth.js');
    // Functions every /api/v1 request passes through before routing.
    const ping = spec.collection.routes.find((r) => r.path === '/api/v1/ping' && r.method === 'get')!;
    const global = new Set<unknown>(ping.chain.slice(0, -1));
    const targets = spec.collection.routes.filter((r) => {
      const own = r.chain.filter((fn) => !global.has(fn));
      return own[0] === authenticate;
    });
    expect(targets.length).toBeGreaterThan(1000);
    console.log(`[openapi] live smoke: ${targets.length} authenticated operations`);

    const server: Server = createServer(spec.app);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    // morgan logs every request; keep the test output readable.
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    const failures: string[] = [];
    try {
      const probe = async (method: string, path: string, i: number) => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: method.toUpperCase(),
          // A distinct client address per request keeps the global
          // per-IP rate limiter (300/min) out of the way; trust proxy
          // defaults to loopback, so the header is honored.
          headers: { 'x-forwarded-for': `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}` },
        });
        const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
        return { status: res.status, code: body.error?.code };
      };

      const control = await probe('get', '/api/v1/definitely-not-a-route', 0);
      expect(control).toEqual({ status: 404, code: 'NOT_FOUND' });

      let i = 1;
      for (const r of targets) {
        const got = await probe(r.method, concrete(r.path), i++);
        if (got.status !== 401) failures.push(`${r.method.toUpperCase()} ${r.path} -> ${got.status} ${got.code ?? ''}`);
      }
    } finally {
      process.stdout.write = write;
      await new Promise<void>((done) => server.close(() => done()));
    }
    expect(failures).toEqual([]);
  }, 120_000);
});

describe('determinism', () => {
  it('two exports are byte-identical', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openapi-det-'));
    try {
      const run = (name: string) => {
        const out = join(dir, name);
        execFileSync(process.execPath, ['--import', 'tsx', 'src/scripts/openapi-export.ts', '--out', out], {
          cwd: API_ROOT,
          stdio: 'pipe',
        });
        return readFileSync(out, 'utf8');
      };
      const a = run('a.json');
      const b = run('b.json');
      expect(a.length).toBeGreaterThan(100_000);
      expect(a === b).toBe(true);
      expect(a === stableStringify(spec.doc)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
