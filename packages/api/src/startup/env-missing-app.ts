// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import express, { type Express } from 'express';
import path from 'path';
import fs from 'fs';
import {
  sentinelExists,
  readSentinelHeader,
  SentinelError,
} from '../services/sentinel.service.js';
import { readHostId } from '../services/host-id.service.js';
import {
  recoveryFileExists,
  readRecoveryFile,
} from '../services/env-recovery.service.js';
import { writeAtomicSync } from '../utils/atomic-write.js';

/**
 * Pre-env diagnostic app. Mounted by bootstrap.ts when required env vars
 * are missing but the sentinel file indicates prior setup. This is the
 * narrowest Express surface in the codebase: it has ZERO transitive imports
 * from config/env.ts or db/index.ts so it can run even when those would
 * crash on startup.
 *
 * Scope (Phase B):
 *   - GET  /api/diagnostic/env-status — returns sentinel header + whether
 *     /data/.env.recovery exists (tells the frontend which UI to render)
 *   - POST /api/diagnostic/env-recovery — takes a recovery key, decrypts
 *     /data/.env.recovery, writes a fresh /data/config/.env with the
 *     recovered values, responds "restart required"
 *   - static frontend from packages/web/dist if available
 *
 * Safety:
 *   - No database connection
 *   - No session / JWT handling
 *   - Rate limit: 10 POSTs per minute per IP (F23)
 *   - Never writes any file except /data/config/.env
 */

interface RateBucket {
  count: number;
  resetAt: number;
}
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, RateBucket>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (bucket.count >= RATE_LIMIT_MAX) return false;
  bucket.count += 1;
  return true;
}

export interface EnvMissingContext {
  missingVars: string[];
  /** True if the sentinel header is readable (whether or not it decrypts). */
  sentinelReadable: boolean;
}

export function createEnvMissingApp(ctx: EnvMissingContext): Express {
  const app = express();
  app.use(express.json({ limit: '16kb' }));

  app.get('/api/diagnostic/env-status', (_req, res) => {
    let header = null;
    let headerError: string | null = null;
    if (sentinelExists()) {
      try {
        header = readSentinelHeader();
      } catch (err) {
        headerError = err instanceof SentinelError ? err.message : (err as Error).message;
      }
    }
    res.json({
      state: 'env-missing',
      missingVars: ctx.missingVars,
      sentinelHeader: header,
      sentinelHeaderError: headerError,
      hostId: readHostId(),
      recoveryFilePresent: recoveryFileExists(),
    });
  });

  app.post('/api/diagnostic/env-recovery', (req, res) => {
    const ip = (req.ip ?? req.socket.remoteAddress ?? 'unknown').toString();
    if (!checkRateLimit(ip)) {
      res.status(429).json({ error: { message: 'too many attempts — wait a minute and retry' } });
      return;
    }

    const body = req.body as { recoveryKey?: string } | undefined;
    const recoveryKey = body?.recoveryKey?.toString();
    if (!recoveryKey) {
      res.status(400).json({ error: { message: 'recoveryKey required' } });
      return;
    }
    if (!recoveryFileExists()) {
      res.status(404).json({ error: { message: 'no /data/.env.recovery file exists on this server' } });
      return;
    }

    let contents;
    try {
      contents = readRecoveryFile(recoveryKey);
    } catch (err) {
      // Intentionally vague on the wire — we don't want to leak whether the
      // key was malformed vs wrong.
      res.status(401).json({ error: { message: 'recovery key did not decrypt the file' } });
      return;
    }
    if (!contents) {
      res.status(404).json({ error: { message: 'recovery file missing after existence check' } });
      return;
    }

    // Write a fresh /data/config/.env with the recovered values. Phase B
    // intentionally only writes the three recovered fields plus a header
    // comment; SMTP / Plaid / AI keys must be re-entered via admin
    // settings after the app restarts.
    const configDir = process.env['CONFIG_DIR'] || '/data/config';
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    const envPath = path.join(configDir, '.env');
    const envBody = `# KIS Books Configuration — Recovered from /data/.env.recovery
# ${new Date().toISOString()}
# Phase B recovery: only the three secrets that cannot be reconstructed
# from admin settings are written here. SMTP, Plaid, AI, and other
# optional credentials must be re-entered after the container restarts.

DATABASE_URL=${contents.databaseUrl}
JWT_SECRET=${contents.jwtSecret}
ENCRYPTION_KEY=${contents.encryptionKey}

# Sensible defaults — adjust after logging in:
NODE_ENV=production
PORT=3001
REDIS_URL=redis://redis:6379
CORS_ORIGIN=http://localhost:5173
UPLOAD_DIR=/data/uploads
BACKUP_DIR=/data/backups
`;

    try {
      writeAtomicSync(envPath, envBody, 0o600);
    } catch (err) {
      res.status(500).json({
        error: { message: `failed to write ${envPath}: ${(err as Error).message}` },
      });
      return;
    }

    // eslint-disable-next-line no-console
    console.log(
      `[sentinel-audit] ${JSON.stringify({
        ts: new Date().toISOString(),
        kind: 'sentinel-audit',
        event: 'recovery.key_used',
        source: 'env-missing-app',
        installationId: contents.installationId,
      })}`,
    );

    res.json({
      success: true,
      message: 'Configuration recovered. Restart the API container to reload with the recovered values.',
    });
  });

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'blocked', code: 'ENV_MISSING' });
  });

  app.use('/api', (_req, res) => {
    res.status(503).json({
      error: {
        message: 'Installation is in env-missing recovery mode — only /api/diagnostic/env-* is available.',
        code: 'ENV_MISSING',
      },
    });
  });

  // Static frontend (same candidate list as diagnostic-app.ts).
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
        'ENV_MISSING — missing variables: ' + ctx.missingVars.join(', ') + '\n' +
          (ctx.sentinelReadable
            ? 'Sentinel header readable — use POST /api/diagnostic/env-recovery with your recovery key.\n'
            : 'No readable sentinel. Restore /data/config/.env from a backup before continuing.\n'),
      );
    });
  }

  return app;
}
