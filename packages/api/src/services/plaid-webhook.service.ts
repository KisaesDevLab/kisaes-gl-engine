// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { eq, and, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { plaidItems, plaidWebhookLog } from '../db/schema/index.js';
import { decrypt } from '../utils/encryption.js';
import { AppError } from '../utils/errors.js';
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

// ─── Webhook registration maintenance ──────────────────────────

export interface ItemWebhookSyncResult {
  itemId: string;
  institutionName: string | null;
  previousWebhook: string | null;
  updated: boolean;
  error?: string;
}

/**
 * Push the configured webhook URL to every active Plaid item.
 *
 * Plaid records the webhook URL per item when it is linked; it does NOT
 * follow later changes to the Link configuration. So after a domain or
 * path change, existing items keep POSTing to the old address until each
 * one gets an explicit /item/webhook/update. Items already on the current
 * URL are left untouched (reported with updated: false, no error).
 */
export async function syncWebhooksToItems(): Promise<{ webhookUrl: string; results: ItemWebhookSyncResult[] }> {
  const plaidClient = await import('./plaid-client.service.js');
  const config = await plaidClient.getConfig();
  if (!config.webhookUrl) throw AppError.badRequest('No webhook URL configured in Plaid settings');
  const webhookUrl = config.webhookUrl;

  const items = await db.select().from(plaidItems).where(isNull(plaidItems.removedAt));
  const results: ItemWebhookSyncResult[] = [];
  for (const item of items) {
    try {
      const accessToken = decrypt(item.accessTokenEncrypted);
      const remote = await plaidClient.getItem(accessToken);
      const previousWebhook = remote.webhook ?? null;
      if (previousWebhook === webhookUrl) {
        results.push({ itemId: item.id, institutionName: item.institutionName, previousWebhook, updated: false });
        continue;
      }
      await plaidClient.updateItemWebhook(accessToken, webhookUrl);
      results.push({ itemId: item.id, institutionName: item.institutionName, previousWebhook, updated: true });
      log.info({
        component: 'plaid-webhook',
        event: 'item_webhook_updated',
        itemId: item.id,
        message: `${item.institutionName || item.id}: ${previousWebhook || '(none)'} → ${webhookUrl}`,
      });
    } catch (err) {
      results.push({
        itemId: item.id,
        institutionName: item.institutionName,
        previousWebhook: null,
        updated: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { webhookUrl, results };
}

export interface WebhookEndpointTestResult {
  webhookUrl: string;
  ok: boolean;
  status?: number;
  detail: string;
}

/**
 * Probe the configured webhook URL from the server with an UNSIGNED POST.
 * A correctly working receiver answers 401 (signature verification rejects
 * the probe) — that proves DNS, TLS, and routing all the way into the app
 * AND that verification is active. 200 means the endpoint would accept
 * forged webhooks; anything else means Plaid's deliveries aren't reaching
 * this install (404 = wrong path/old app, 5xx/network = unreachable).
 */
export async function testWebhookEndpoint(): Promise<WebhookEndpointTestResult> {
  const plaidClient = await import('./plaid-client.service.js');
  const config = await plaidClient.getConfig();
  if (!config.webhookUrl) throw AppError.badRequest('No webhook URL configured in Plaid settings');
  const webhookUrl = config.webhookUrl;

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10_000);
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhook_type: 'CONNECTIVITY_TEST', webhook_code: 'ADMIN_PROBE' }),
      signal: ac.signal,
    }).finally(() => clearTimeout(timer));

    if (res.status === 401) {
      return { webhookUrl, ok: true, status: 401, detail: 'Endpoint reachable; unsigned probe correctly rejected (signature verification active).' };
    }
    if (res.status === 200) {
      return { webhookUrl, ok: false, status: 200, detail: 'Endpoint ACCEPTED an unsigned probe — signature verification is not working at this URL.' };
    }
    if (res.status === 404) {
      return { webhookUrl, ok: false, status: 404, detail: 'HTTP 404 — no webhook receiver at this URL. Check the domain and path (…/api/v1/plaid/webhooks).' };
    }
    return { webhookUrl, ok: false, status: res.status, detail: `Unexpected HTTP ${res.status} from the webhook URL.` };
  } catch (err) {
    const message = err instanceof Error && err.name === 'AbortError' ? 'Timed out after 10s' : err instanceof Error ? err.message : String(err);
    return { webhookUrl, ok: false, detail: `Unreachable: ${message}` };
  }
}
