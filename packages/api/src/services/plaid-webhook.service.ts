// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { plaidItems, plaidWebhookLog } from '../db/schema/index.js';
import { log } from '../utils/logger.js';

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
          } catch (err) {
            // syncItem records lastSyncError on the row but emits no log line
            // and rethrows; without this a webhook-driven sync failure leaves
            // zero operator-visible signal. Don't log the access_token.
            log.error({
              component: 'plaid-webhook',
              event: 'sync_failed',
              itemId: item.id,
              message: err instanceof Error ? err.message : String(err),
            });
          }
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
        case 'ERROR': {
          const wasHealthy = !item.itemStatus || item.itemStatus === 'active';
          await db.update(plaidItems).set({
            itemStatus: body.error?.error_code === 'ITEM_LOGIN_REQUIRED' ? 'login_required' : 'error',
            errorCode: body.error?.error_code || null,
            errorMessage: body.error?.error_message || null,
            updatedAt: new Date(),
          }).where(eq(plaidItems.id, item.id));
          // Email the mapped tenants' owners — only on the TRANSITION into an
          // error state, so Plaid's repeated ERROR webhooks for the same
          // outage don't spam.
          if (wasHealthy) {
            const { sendConnectionErrorNotice } = await import('./email.service.js');
            sendConnectionErrorNotice(item.id, item.institutionName, body.error?.error_message || body.error?.error_code || null)
              .catch((err) => console.warn('[plaid-webhook] error notice failed:', err instanceof Error ? err.message : err));
          }
          break;
        }

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
