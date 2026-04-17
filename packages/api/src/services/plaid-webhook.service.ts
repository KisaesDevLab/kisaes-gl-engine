// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { plaidItems, plaidWebhookLog } from '../db/schema/index.js';

export async function handleWebhook(body: any) {
  const { webhook_type, webhook_code, item_id } = body;

  // Log the webhook
  await db.insert(plaidWebhookLog).values({
    plaidItemId: item_id || null,
    webhookType: webhook_type,
    webhookCode: webhook_code,
    payload: body,
  });

  if (!item_id) return;

  // Find the item
  const item = await db.query.plaidItems.findFirst({
    where: eq(plaidItems.plaidItemId, item_id),
  });
  if (!item) return;

  // Route based on type + code
  switch (webhook_type) {
    case 'TRANSACTIONS': {
      switch (webhook_code) {
        case 'SYNC_UPDATES_AVAILABLE':
          // Trigger sync for this item
          const { syncItem } = await import('./plaid-sync.service.js');
          try {
            await syncItem(item.id);
          } catch { /* logged by syncItem */ }
          break;

        case 'INITIAL_UPDATE':
          await db.update(plaidItems).set({ initialUpdateComplete: true, updatedAt: new Date() })
            .where(eq(plaidItems.id, item.id));
          break;

        case 'HISTORICAL_UPDATE':
          await db.update(plaidItems).set({ historicalUpdateComplete: true, updatedAt: new Date() })
            .where(eq(plaidItems.id, item.id));
          break;
      }
      break;
    }

    case 'ITEM': {
      switch (webhook_code) {
        case 'ERROR':
          await db.update(plaidItems).set({
            itemStatus: body.error?.error_code === 'ITEM_LOGIN_REQUIRED' ? 'login_required' : 'error',
            errorCode: body.error?.error_code || null,
            errorMessage: body.error?.error_message || null,
            updatedAt: new Date(),
          }).where(eq(plaidItems.id, item.id));
          break;

        case 'LOGIN_REPAIRED':
          await db.update(plaidItems).set({
            itemStatus: 'active', errorCode: null, errorMessage: null, updatedAt: new Date(),
          }).where(eq(plaidItems.id, item.id));
          break;

        case 'PENDING_DISCONNECT':
          await db.update(plaidItems).set({
            itemStatus: 'pending_disconnect', updatedAt: new Date(),
          }).where(eq(plaidItems.id, item.id));
          break;

        case 'USER_PERMISSION_REVOKED':
          await db.update(plaidItems).set({
            itemStatus: 'revoked', updatedAt: new Date(),
          }).where(eq(plaidItems.id, item.id));
          break;

        case 'NEW_ACCOUNTS_AVAILABLE':
          // Flag the item so user sees "new accounts available" in their connections page
          await db.update(plaidItems).set({
            errorCode: 'NEW_ACCOUNTS_AVAILABLE',
            errorMessage: 'New accounts are available for this connection. Review your account mappings.',
            updatedAt: new Date(),
          }).where(eq(plaidItems.id, item.id));
          break;
      }
      break;
    }
  }

  // Mark webhook as processed
  // Find the most recent unprocessed webhook for this item/type/code
  const logEntry = await db.query.plaidWebhookLog.findFirst({
    where: and(
      eq(plaidWebhookLog.plaidItemId, item_id),
      eq(plaidWebhookLog.webhookType, webhook_type),
      eq(plaidWebhookLog.webhookCode, webhook_code),
      eq(plaidWebhookLog.processed, false),
    ),
  });
  if (logEntry) {
    await db.update(plaidWebhookLog).set({ processed: true, processedAt: new Date() })
      .where(eq(plaidWebhookLog.id, logEntry.id));
  }
}
