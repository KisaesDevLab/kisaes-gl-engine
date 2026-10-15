// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, afterEach } from 'vitest';
// app.ts loads this too: it replaces every layer.handle with a wrapper,
// which is exactly what the recorder must see through.
import 'express-async-errors';
import express, { type Request, type Response, type NextFunction } from 'express';
import {
  installRecorder,
  countStackRoutes,
  joinPaths,
  toOpenApiPath,
  type Recorder,
} from './recorder.js';

// Synthetic apps only — no engine modules are imported here, so these
// tests need neither a database nor Redis.

let recorder: Recorder | null = null;
afterEach(() => {
  recorder?.uninstall();
  recorder = null;
});

const ok = (_req: Request, res: Response) => { res.json({ ok: true }); };
function auth(_req: Request, _res: Response, next: NextFunction) { next(); }
function audit(_req: Request, _res: Response, next: NextFunction) { next(); }

function ids(routes: Array<{ method: string; path: string }>): string[] {
  return routes.map((r) => `${r.method.toUpperCase()} ${r.path}`).sort();
}

describe('openapi recorder', () => {
  it('records app-level methods with params and ignores app.get(setting)', () => {
    recorder = installRecorder();
    const app = express();
    app.set('x-flag', 1);
    expect(app.get('x-flag')).toBe(1); // single-arg get is a settings read
    app.get('/health', ok);
    app.post('/api/v1/items/:id/copy', ok);
    app.delete('/api/v1/items/:id', ok);

    const { routes, skipped } = recorder.collect(app);
    expect(ids(routes)).toEqual([
      'DELETE /api/v1/items/{id}',
      'GET /health',
      'POST /api/v1/items/{id}/copy',
    ]);
    expect(routes.find((r) => r.method === 'post')!.params).toEqual(['id']);
    expect(routes.find((r) => r.method === 'post')!.expressPath).toBe('/api/v1/items/:id/copy');
    expect(skipped).toEqual([]);
  });

  it('expands nested routers, router.route() and a router mounted twice', () => {
    recorder = installRecorder();
    const inner = express.Router();
    inner.get('/', ok);
    inner.route('/:entryId').get(ok).put(ok);

    const shared = express.Router();
    shared.get('/rules', ok);
    shared.use('/entries', inner);

    const app = express();
    app.use('/api/v1/a', shared);
    app.use('/api/v1/b', shared);

    const { routes } = recorder.collect(app);
    expect(ids(routes)).toEqual([
      'GET /api/v1/a/entries',
      'GET /api/v1/a/entries/{entryId}',
      'GET /api/v1/a/rules',
      'GET /api/v1/b/entries',
      'GET /api/v1/b/entries/{entryId}',
      'GET /api/v1/b/rules',
      'PUT /api/v1/a/entries/{entryId}',
      'PUT /api/v1/b/entries/{entryId}',
    ]);
    expect(countStackRoutes(app)).toBe(routes.length);
  });

  it('merges two routers on one base and reports shadowed duplicates', () => {
    recorder = installRecorder();
    const first = express.Router();
    first.get('/packs', ok);
    first.get('/shared', ok);
    const second = express.Router();
    second.get('/profit-loss', ok);
    second.get('/shared', ok);
    const app = express();
    app.use('/api/v1/reports', first);
    app.use('/api/v1/reports', second);

    const { routes, shadowed } = recorder.collect(app);
    expect(ids(routes)).toEqual([
      'GET /api/v1/reports/packs',
      'GET /api/v1/reports/profit-loss',
      'GET /api/v1/reports/shared',
    ]);
    expect(ids(shadowed)).toEqual(['GET /api/v1/reports/shared']);
    expect(countStackRoutes(app)).toBe(routes.length + shadowed.length);
  });

  it('builds the middleware chain in registration order', () => {
    recorder = installRecorder();
    const router = express.Router();
    router.get('/public', ok);
    router.use(auth);
    router.get('/private', audit, ok);

    const app = express();
    app.use('/api', audit);
    app.use('/api/v1/x', router);
    app.use('/api/v1/admin', auth, express.Router().get('/stats', ok));

    const { routes } = recorder.collect(app);
    // Express adds its own `query` and `expressInit` middleware to the
    // root router; keep only the functions this test registered.
    const mine = new Set<unknown>([auth, audit, ok]);
    const chain = (p: string) => routes.find((r) => r.path === p)!.chain.filter((f) => mine.has(f));
    expect(chain('/api/v1/x/public')).toEqual([audit, ok]);
    expect(chain('/api/v1/x/private')).toEqual([audit, auth, audit, ok]);
    expect(chain('/api/v1/admin/stats')).toEqual([audit, auth, ok]);
  });

  it('skips wildcard, regexp, optional-param and all() registrations with keys', () => {
    recorder = installRecorder();
    const router = express.Router();
    router.get('/files/*', ok);
    router.get(/^\/legacy\/.*$/, ok);
    router.get('/report/:format?', ok);
    router.all('/proxy', ok);
    router.get('/fine', ok);
    const app = express();
    app.use('/api/v1/docs', router);
    app.use(/^\/regex-mount/, express.Router().get('/x', ok));

    const { routes, skipped } = recorder.collect(app);
    expect(ids(routes)).toEqual(['GET /api/v1/docs/fine']);
    expect(skipped.map((s) => s.key).sort()).toEqual([
      'ALL /api/v1/docs/proxy',
      'GET /api/v1/docs/files/*',
      'GET /api/v1/docs/report/:format?',
      'ROUTE /api/v1/docs /^\\/legacy\\/.*$/',
      'USE / /^\\/regex-mount/',
    ].sort());
  });

  it('keeps original handler identities under express-async-errors wrapping', () => {
    recorder = installRecorder();
    const router = express.Router();
    router.use(auth);
    router.route('/r').all(audit).post(ok);
    const app = express();
    app.use('/api/v1/w', router);

    const { routes } = recorder.collect(app);
    const post = routes.find((r) => r.path === '/api/v1/w/r')!;
    expect(post.chain.slice(-3)).toEqual([auth, audit, ok]);
    // The wrapped layer handles are different functions.
    const layer = (app as unknown as { _router: { stack: Array<{ handle: unknown }> } })._router.stack.at(-1)!;
    expect(layer.handle).not.toBe(router);
    expect(countStackRoutes(app)).toBe(2); // post + the all() layer
  });

  it('expands array mount paths of plain strings', () => {
    recorder = installRecorder();
    const router = express.Router();
    router.use(['/catalog', '/packs'], audit);
    router.get('/catalog', ok);
    router.get('/other', ok);
    const app = express();
    app.use('/api/v1/reports', router);
    const { routes, skipped } = recorder.collect(app);
    const mine = (p: string) => routes.find((r) => r.path === p)!.chain.filter((f) => f === audit || f === ok);
    expect(mine('/api/v1/reports/catalog')).toEqual([audit, ok]);
    expect(mine('/api/v1/reports/other')).toEqual([ok]);
    expect(skipped).toEqual([]);
  });

  it('uninstall restores the original prototype methods', () => {
    const routeProto = (express as unknown as { Route: { prototype: { get: unknown } } }).Route.prototype;
    const before = (express.Router as unknown as { use: unknown }).use;
    const beforeGet = routeProto.get;
    recorder = installRecorder();
    expect((express.Router as unknown as { use: unknown }).use).not.toBe(before);
    expect(routeProto.get).not.toBe(beforeGet);
    recorder.uninstall();
    expect((express.Router as unknown as { use: unknown }).use).toBe(before);
    expect(routeProto.get).toBe(beforeGet);
    expect(() => installRecorder().uninstall()).not.toThrow();
  });

  it('refuses a second concurrent install', () => {
    recorder = installRecorder();
    expect(() => installRecorder()).toThrow(/already installed/);
  });
});

describe('path helpers', () => {
  it('joinPaths', () => {
    expect(joinPaths('/', '/')).toBe('/');
    expect(joinPaths('/', '/health')).toBe('/health');
    expect(joinPaths('/api/v1/a', '/')).toBe('/api/v1/a');
    expect(joinPaths('/api/v1/a/', '/b/')).toBe('/api/v1/a/b');
  });

  it('toOpenApiPath', () => {
    expect(toOpenApiPath('/a/:id/b/:sub_id')).toEqual({ path: '/a/{id}/b/{sub_id}', params: ['id', 'sub_id'] });
    expect(toOpenApiPath('/files/*')).toBeNull();
    expect(toOpenApiPath('/x/:id?')).toBeNull();
    expect(toOpenApiPath('/x/:id(\\d+)')).toBeNull();
    expect(toOpenApiPath('/x/:from-:to')).toBeNull();
    expect(toOpenApiPath('/report.pdf')).toEqual({ path: '/report.pdf', params: [] });
  });
});
