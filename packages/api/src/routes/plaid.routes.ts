// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import * as plaidClient from '../services/plaid-client.service.js';
import * as plaidConnection from '../services/plaid-connection.service.js';
import * as plaidMapping from '../services/plaid-mapping.service.js';
import * as plaidSync from '../services/plaid-sync.service.js';
import * as plaidWebhook from '../services/plaid-webhook.service.js';

export const plaidRouter = Router();

// ─── Link Token ────────────────────────────────────────────────

plaidRouter.post('/link-token', authenticate, async (req, res) => {
  const linkToken = await plaidClient.createLinkToken('system', req.userId);
  res.json({ linkToken });
});

plaidRouter.post('/link-token/update', authenticate, async (req, res) => {
  const linkToken = await plaidConnection.getUpdateLinkToken(req.body.itemId, req.userId);
  res.json({ linkToken });
});

// ─── Exchange & Connection (System-Scoped) ─────────────────────

plaidRouter.post('/exchange', authenticate, async (req, res) => {
  const result = await plaidConnection.createConnection(req.userId, req.body.publicToken, {
    institutionId: req.body.institutionId,
    institutionName: req.body.institutionName,
    accounts: req.body.accounts,
    linkSessionId: req.body.linkSessionId,
  });
  res.status(201).json(result);
});

// ─── Check Existing Institution ────────────────────────────────

plaidRouter.get('/check-institution', authenticate, async (req, res) => {
  const institutionId = req.query['institutionId'] as string;
  const existing = await plaidConnection.checkExistingInstitution(institutionId);
  if (existing) {
    const { accounts, hiddenAccountCount } = await plaidConnection.getVisibleAccounts(req.userId, existing.id);
    res.json({ exists: true, item: { ...existing, accessTokenEncrypted: undefined }, accounts, hiddenAccountCount });
  } else {
    res.json({ exists: false });
  }
});

// ─── Items (Filtered by User Visibility) ──────────────────────

plaidRouter.get('/items', authenticate, async (req, res) => {
  const items = await plaidConnection.getItemsForUser(req.userId);
  res.json({ items });
});

plaidRouter.get('/items/:id', authenticate, async (req, res) => {
  const item = await plaidConnection.getItemDetail(req.userId, req.params['id']!);
  res.json(item);
});

// ─── Tier 1: Unmap Company ─────────────────────────────────────

plaidRouter.post('/items/:id/unmap-company', authenticate, async (req, res) => {
  // Visibility gate: the caller must already have a relationship to
  // this item (creator, super admin, or mapped into one of its
  // accounts in a tenant they can access). Without this, any
  // authenticated user could probe /items/:id/unmap-company with
  // random UUIDs.
  await plaidConnection.assertCanAccessItem(req.userId, req.params['id']!);
  await plaidConnection.unmapCompany(req.params['id']!, req.tenantId, req.body.deletePendingItems ?? false, req.userId);
  res.json({ unmapped: true });
});

// ─── Tier 2: Delete Connection ─────────────────────────────────

plaidRouter.delete('/items/:id', authenticate, async (req, res) => {
  // `deleteConnection` already enforces creator / super-admin / admin-of-all-tenants
  // permission internally; we still pre-check here so random-UUID probes
  // can't distinguish "doesn't exist" from "exists but not yours".
  await plaidConnection.assertCanAccessItem(req.userId, req.params['id']!);
  // `deletePendingItems` comes from the query string to avoid relying
  // on DELETE request bodies (many clients strip them).
  const deletePending =
    req.query['deletePendingItems'] === 'true' || req.body?.deletePendingItems === true;
  await plaidConnection.deleteConnection(req.params['id']!, deletePending, req.userId);
  res.json({ removed: true });
});

// ─── Account Mapping (Two-Step) ────────────────────────────────

plaidRouter.post('/accounts/:id/assign', authenticate, async (req, res) => {
  // Tenant comes from the JWT only (CLAUDE.md §17 — never trust
  // client-supplied tenant_id). The previous version of this route
  // accepted `req.body.tenantId` and let a user assign a Plaid
  // account into any tenant whose COA account UUID they knew.
  const mapping = await plaidMapping.assignAccountToCompany(
    req.params['id']!, req.tenantId, req.body.coaAccountId,
    req.body.syncStartDate || null, req.userId,
  );
  res.status(201).json(mapping);
});

plaidRouter.post('/accounts/:id/unmap', authenticate, async (req, res) => {
  await plaidMapping.unmapAccount(req.params['id']!, req.tenantId);
  res.json({ unmapped: true });
});

plaidRouter.put('/accounts/:id/remap', authenticate, async (req, res) => {
  const mapping = await plaidMapping.remapAccount(req.params['id']!, req.tenantId, req.body.coaAccountId, req.userId);
  res.json(mapping);
});

plaidRouter.put('/accounts/:id/sync-date', authenticate, async (req, res) => {
  await plaidMapping.updateSyncStartDate(req.params['id']!, req.tenantId, req.body.syncStartDate);
  res.json({ updated: true });
});

plaidRouter.put('/accounts/:id/sync-toggle', authenticate, async (req, res) => {
  await plaidMapping.toggleSync(req.params['id']!, req.tenantId, req.body.enabled);
  res.json({ updated: true });
});

plaidRouter.get('/accounts/:id/suggestions', authenticate, async (req, res) => {
  const suggestions = await plaidMapping.autoSuggestMapping(req.tenantId, req.params['id']!);
  res.json({ suggestions });
});

plaidRouter.post('/accounts/:id/create-and-map', authenticate, async (req, res) => {
  const account = await plaidMapping.createAndMapAccount(
    req.tenantId, req.params['id']!, req.body, req.body.syncStartDate || null, req.userId,
  );
  res.status(201).json(account);
});

// ─── Sync ──────────────────────────────────────────────────────

plaidRouter.post('/items/:id/sync', authenticate, async (req, res) => {
  await plaidConnection.assertCanAccessItem(req.userId, req.params['id']!);
  const result = await plaidSync.syncItem(req.params['id']!);
  res.json(result);
});

plaidRouter.get('/items/:id/sync-history', authenticate, async (req, res) => {
  await plaidConnection.assertCanAccessItem(req.userId, req.params['id']!);
  const { db } = await import('../db/index.js');
  const { plaidItems } = await import('../db/schema/index.js');
  const { eq } = await import('drizzle-orm');
  const item = await db.query.plaidItems.findFirst({ where: eq(plaidItems.id, req.params['id']!) });
  if (!item) { res.status(404).json({ error: { message: 'Not found' } }); return; }

  res.json({
    lastSyncAt: item.lastSyncAt,
    lastSyncStatus: item.lastSyncStatus,
    lastSyncError: item.lastSyncError,
    initialUpdateComplete: item.initialUpdateComplete,
    historicalUpdateComplete: item.historicalUpdateComplete,
  });
});

// ─── Activity Log ──────────────────────────────────────────────

plaidRouter.get('/items/:id/activity', authenticate, async (req, res) => {
  await plaidConnection.assertCanAccessItem(req.userId, req.params['id']!);
  const { db } = await import('../db/index.js');
  const { plaidItemActivity } = await import('../db/schema/index.js');
  const { eq, or, and, isNull, desc } = await import('drizzle-orm');

  const logs = await db.select().from(plaidItemActivity)
    .where(and(
      eq(plaidItemActivity.plaidItemId, req.params['id']!),
      or(eq(plaidItemActivity.tenantId, req.tenantId), isNull(plaidItemActivity.tenantId)),
    ))
    .orderBy(desc(plaidItemActivity.createdAt))
    .limit(50);

  res.json({ activity: logs });
});

// ─── Webhooks (verified by signature) ──────────────────────────

plaidRouter.post('/webhooks', async (req, res) => {
  try {
    const rawBody = JSON.stringify(req.body);
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
    const verified = await plaidClient.verifyWebhook(rawBody, headers);
    if (!verified) {
      res.status(401).json({ error: 'Webhook verification failed' });
      return;
    }
    await plaidWebhook.handleWebhook(req.body);
    res.json({ received: true });
  } catch (err: any) {
    console.error('[Plaid Webhook] Error:', err.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});
