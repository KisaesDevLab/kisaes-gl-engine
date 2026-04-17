// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import express, { type Express } from 'express';
import path from 'path';
import fs from 'fs';
import { createDiagnosticRouter } from '../routes/diagnostic.routes.js';
import type { ValidationResult } from './installation-validator.js';

/**
 * Build the minimal Express app served when preflight blocks normal startup.
 * This app intentionally does NOT mount:
 *   - the regular /api/auth, /api/setup, or any domain routes
 *   - any DB-touching middleware (authentication, tenant guard, etc.)
 *   - the normal error handler (which assumes request context we don't set)
 *
 * What it DOES mount:
 *   - /api/diagnostic/status
 *   - /api/diagnostic/regenerate-sentinel
 *   - the built Vite frontend from packages/web/dist (if present), which
 *     serves DiagnosticRouter.tsx and pulls it onto the right page
 *
 * F7: separating this app from the normal one guarantees that when the
 * validator says "block", the setup routes (protected only by the
 * .initialized marker) cannot be reached — even if some other bug leaves
 * the marker in a weird state.
 */
export function createDiagnosticApp(cached: ValidationResult): Express {
  const app = express();

  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'blocked', code: cached.status === 'blocked' ? cached.code : cached.status });
  });

  app.use('/api/diagnostic', createDiagnosticRouter(cached));

  // Refuse every other /api/* call with a clear message. An attacker who
  // guesses at /api/setup/initialize while the diagnostic app is running
  // must not silently get a 404 that looks like "setup wasn't mounted yet."
  app.use('/api', (_req, res) => {
    res.status(503).json({
      error: {
        message: 'Installation is in a diagnostic state — only /api/diagnostic/* routes are available.',
        code: cached.status === 'blocked' ? cached.code : cached.status,
      },
    });
  });

  // Static frontend. The web build is copied into the api image under
  // /app/packages/web/dist in production. In dev we simply skip it — the
  // dev wizard is served from Vite on a separate port anyway.
  const webDistCandidates = [
    path.resolve(process.cwd(), 'packages/web/dist'),
    path.resolve(process.cwd(), '../web/dist'),
    '/app/packages/web/dist',
  ];
  const webDist = webDistCandidates.find((p) => fs.existsSync(path.join(p, 'index.html')));
  if (webDist) {
    app.use(express.static(webDist));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
  } else {
    app.get('*', (_req, res) => {
      res.status(503).type('text/plain').send(
        'Installation blocked. Web bundle not found — use /api/diagnostic/status to inspect state.\n' +
          `Code: ${cached.status === 'blocked' ? cached.code : cached.status}\n`,
      );
    });
  }

  return app;
}
