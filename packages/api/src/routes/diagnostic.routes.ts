import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  sentinelExists,
  readSentinelHeader,
  createSentinel,
  deleteSentinel,
  SentinelError,
} from '../services/sentinel.service.js';
import { ensureHostId, readHostId } from '../services/host-id.service.js';
import { getSetting, setSetting } from '../services/admin.service.js';
import { SystemSettingsKeys } from '../constants/system-settings-keys.js';
import { withSetupLock } from '../services/setup.service.js';
import { sentinelAudit } from '../startup/sentinel-audit.js';
import type { ValidationResult } from '../startup/installation-validator.js';

/**
 * Diagnostic routes — the only HTTP endpoints mounted when the app is
 * started in blocked state by bootstrap.ts. NO auth middleware, NO db
 * middleware, NO setup routes. Intentionally kept tiny so the blocked-state
 * surface area is minimal.
 *
 * Routes:
 *   GET  /api/diagnostic/status
 *     Returns the cached validation result from the preflight run that
 *     decided to block, plus the (unencrypted) sentinel header if present.
 *     Used by the React DiagnosticRouter to pick which page to render.
 *
 *   POST /api/diagnostic/regenerate-sentinel
 *     Authenticates against the users table with bcrypt. On success,
 *     deletes the existing sentinel and writes a new one using the current
 *     DB installation_id. Used for Case 5 (wrong key / corrupt sentinel)
 *     recovery where the user still has valid admin credentials and a
 *     working ENCRYPTION_KEY.
 */
export function createDiagnosticRouter(cached: ValidationResult): Router {
  const router = Router();

  router.get('/status', (_req: Request, res: Response) => {
    let header = null;
    if (sentinelExists()) {
      try {
        header = readSentinelHeader();
      } catch {
        // Leave header null — the caller's code already reflects the
        // corruption state.
      }
    }
    res.json({
      result: cached,
      sentinelHeader: header,
      hostId: readHostId(),
    });
  });

  router.post('/regenerate-sentinel', async (req: Request, res: Response) => {
    const body = req.body as { email?: string; password?: string } | undefined;
    const email = body?.email?.toString().trim();
    const password = body?.password?.toString();

    if (!email || !password) {
      res.status(400).json({ error: { message: 'email and password required' } });
      return;
    }

    // Authenticate directly against users table. No session, no JWT — the
    // normal auth middleware isn't mounted in diagnostic mode because it
    // pulls in too many DB dependencies.
    let user: { id: string; passwordHash: string; isSuperAdmin: boolean; email: string } | null = null;
    try {
      const rows = await db.execute(sql`
        SELECT id, password_hash as "passwordHash", is_super_admin as "isSuperAdmin", email
        FROM users
        WHERE email = ${email}
        LIMIT 1
      `);
      const row = (rows.rows as any[])[0];
      if (row) {
        user = { id: row.id, passwordHash: row.passwordHash, isSuperAdmin: row.isSuperAdmin, email: row.email };
      }
    } catch (err) {
      res.status(500).json({ error: { message: 'database unreachable — cannot authenticate' } });
      return;
    }

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      res.status(401).json({ error: { message: 'invalid credentials' } });
      return;
    }
    if (!user.isSuperAdmin) {
      res.status(403).json({ error: { message: 'super admin required' } });
      return;
    }

    const encryptionKey = process.env['ENCRYPTION_KEY'];
    const jwtSecret = process.env['JWT_SECRET'];
    const databaseUrl = process.env['DATABASE_URL'];
    if (!encryptionKey || !jwtSecret || !databaseUrl) {
      res.status(500).json({
        error: {
          message: 'ENCRYPTION_KEY, JWT_SECRET, and DATABASE_URL must all be set to regenerate the sentinel',
        },
      });
      return;
    }

    try {
      await withSetupLock(async () => {
        // Prefer the existing installation_id if present; otherwise generate a
        // fresh one (this happens if the DB also lost its row but somehow has
        // users — shouldn't normally occur, but the endpoint is used for
        // recovery so we lean toward "do something useful").
        let installationId = await getSetting(SystemSettingsKeys.INSTALLATION_ID);
        if (!installationId) {
          installationId = crypto.randomUUID();
          await setSetting(SystemSettingsKeys.INSTALLATION_ID, installationId);
        }

        const hostId = ensureHostId();
        deleteSentinel();
        createSentinel(
          {
            installationId,
            hostId,
            adminEmail: user!.email,
            appVersion: process.env['APP_VERSION'] || '0.1.0',
            databaseUrl,
            jwtSecret,
            tenantCountAtSetup: 1,
          },
          encryptionKey,
        );

        sentinelAudit('sentinel.regenerate', {
          source: 'diagnostic-endpoint',
          userEmail: user!.email,
          installationId,
          hostId,
        });
      });
    } catch (err) {
      const message = err instanceof SentinelError ? err.message : (err as Error).message;
      res.status(500).json({ error: { message: `sentinel regeneration failed: ${message}` } });
      return;
    }

    res.json({ success: true, message: 'Sentinel regenerated. Restart the container to reload.' });
  });

  return router;
}
