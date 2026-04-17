// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router, type Request } from 'express';
import {
  tailscaleConnectSchema,
  tailscaleDisconnectSchema,
  tailscaleServeSchema,
  tailscaleAuditFiltersSchema,
} from '@kis-books/shared';
import { validate } from '../middleware/validate.js';
import * as statusService from '../services/tailscale/status.service.js';
import * as controlService from '../services/tailscale/control.service.js';
import * as healthService from '../services/tailscale/health.service.js';
import * as auditService from '../services/tailscale/audit.service.js';
import * as updateCheckService from '../services/tailscale/update-check.service.js';
import type { AuditContext } from '../services/tailscale/audit.service.js';

export const tailscaleRouter = Router();

function auditCtx(req: Request): AuditContext {
  return {
    actorUserId: req.userId ?? null,
    ipAddress: req.ip ?? null,
  };
}

// ─── Status ─────────────────────────────────────────────────────

tailscaleRouter.get('/status', async (_req, res) => {
  const status = await statusService.getStatus();
  res.json(status);
});

tailscaleRouter.get('/peers', async (_req, res) => {
  const peers = await statusService.getPeers();
  res.json({ peers });
});

tailscaleRouter.get('/ip', async (_req, res) => {
  const ips = await statusService.getIPs();
  res.json({ ips });
});

tailscaleRouter.get('/version', async (_req, res) => {
  const version = await statusService.getVersion();
  res.json({ version });
});

// ─── Update Check ───────────────────────────────────────────────

tailscaleRouter.get('/update-check', async (req, res) => {
  const force = req.query['refresh'] === '1' || req.query['refresh'] === 'true';
  const result = await updateCheckService.checkForUpdate({ force });
  res.json(result);
});

// ─── Health & Diagnostics ───────────────────────────────────────

tailscaleRouter.get('/health', async (_req, res) => {
  const health = await healthService.getHealth();
  res.json(health);
});

// ─── Control ────────────────────────────────────────────────────

tailscaleRouter.post(
  '/connect',
  validate(tailscaleConnectSchema),
  async (req, res) => {
    const result = await controlService.connect(req.body, auditCtx(req));
    res.json(result);
  },
);

tailscaleRouter.post(
  '/disconnect',
  validate(tailscaleDisconnectSchema),
  async (req, res) => {
    const result = await controlService.disconnect(auditCtx(req));
    res.json(result);
  },
);

tailscaleRouter.post('/reauth', async (req, res) => {
  const result = await controlService.reauth(auditCtx(req));
  res.json(result);
});

// ─── Serve (remote-access HTTPS proxy) ─────────────────────────

tailscaleRouter.get('/serve', async (_req, res) => {
  const serve = await controlService.getServeStatus();
  res.json(serve);
});

tailscaleRouter.post(
  '/serve',
  validate(tailscaleServeSchema),
  async (req, res) => {
    const serve = await controlService.enableServe(req.body.targetPort, auditCtx(req));
    res.json(serve);
  },
);

tailscaleRouter.delete('/serve', async (req, res) => {
  const serve = await controlService.disableServe(auditCtx(req));
  res.json(serve);
});

// ─── Audit ──────────────────────────────────────────────────────

tailscaleRouter.get('/audit', async (req, res) => {
  const filters = tailscaleAuditFiltersSchema.parse(req.query);
  const page = await auditService.listTailscaleAudit(filters);
  res.json(page);
});

tailscaleRouter.get('/audit/export', async (req, res) => {
  const filters = tailscaleAuditFiltersSchema.parse({ ...req.query, limit: 200, page: 1 });
  const page = await auditService.listTailscaleAudit(filters);
  const header = 'id,created_at,action,actor_email,actor_user_id,target,ip_address,details';
  const rows = page.entries.map((e) => {
    const cells = [
      e.id,
      e.createdAt,
      e.action,
      e.actorEmail ?? '',
      e.actorUserId ?? '',
      e.target ?? '',
      e.ipAddress ?? '',
      JSON.stringify(e.details ?? {}),
    ];
    return cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',');
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="tailscale-audit.csv"');
  res.send([header, ...rows].join('\n'));
});
