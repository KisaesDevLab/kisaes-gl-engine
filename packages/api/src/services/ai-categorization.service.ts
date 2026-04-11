import { eq, and, sql, ilike } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bankFeedItems, accounts, contacts, categorizationHistory } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as aiConfigService from './ai-config.service.js';
import * as orchestrator from './ai-orchestrator.service.js';

// Three-layer categorization: Rules → History → AI

export async function categorize(tenantId: string, feedItemId: string) {
  const item = await db.query.bankFeedItems.findFirst({
    where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)),
  });
  if (!item || !item.description) return null;

  const description = item.description.toLowerCase().trim();

  // Layer 1: Bank Rules (handled elsewhere — check if already suggested)
  if (item.suggestedAccountId && item.confidenceScore && parseFloat(item.confidenceScore) >= 0.9) {
    return { accountId: item.suggestedAccountId, confidence: parseFloat(item.confidenceScore), matchType: 'rule' as const };
  }

  // Layer 2: Categorization history — if payee confirmed 3+ times, use it
  const history = await db.query.categorizationHistory.findFirst({
    where: and(eq(categorizationHistory.tenantId, tenantId), eq(categorizationHistory.payeePattern, description)),
  });

  if (history && history.timesConfirmed! >= 3) {
    await db.update(bankFeedItems).set({
      suggestedAccountId: history.accountId,
      suggestedContactId: history.contactId,
      confidenceScore: '0.95',
      updatedAt: new Date(),
    }).where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)));

    // Resolve contact name for the cleansing pipeline
    let contactName: string | null = null;
    if (history.contactId) {
      const contact = await db.query.contacts.findFirst({
        where: and(eq(contacts.tenantId, tenantId), eq(contacts.id, history.contactId)),
      });
      contactName = contact?.displayName || null;
    }

    return { accountId: history.accountId, contactId: history.contactId, contactName, confidence: 0.95, matchType: 'history' as const };
  }

  // Layer 3: AI categorization
  const config = await aiConfigService.getConfig();
  if (!config.isEnabled || !config.categorizationProvider) return null;

  // Get tenant's COA
  const coaAccounts = await db.select({ id: accounts.id, name: accounts.name, accountNumber: accounts.accountNumber, accountType: accounts.accountType })
    .from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.isActive, true)));

  const coaList = coaAccounts.map((a) => `${a.accountNumber || ''} ${a.name} (${a.accountType})`).join('\n');

  // Get known vendors
  const vendors = await db.select({ id: contacts.id, displayName: contacts.displayName })
    .from(contacts).where(and(eq(contacts.tenantId, tenantId), eq(contacts.isActive, true))).limit(200);
  const vendorList = vendors.map((v) => v.displayName).join(', ');

  const job = await orchestrator.createJob(tenantId, 'categorize', 'bank_feed_item', feedItemId, { description: item.description, amount: item.amount });

  try {
    const rawConfig = await aiConfigService.getRawConfig();
    const { executeWithFallback } = await import('./ai-providers/index.js');

    const result = await executeWithFallback({
      systemPrompt: `You are a bookkeeping assistant. Categorize the bank transaction into the correct Chart of Accounts entry. Return JSON only: { "account_name": "...", "vendor_name": "...", "memo": "...", "confidence": 0.0-1.0 }`,
      userPrompt: `Transaction: "${item.description}" | Amount: ${item.amount}\n\nChart of Accounts:\n${coaList}\n\nKnown vendors: ${vendorList}\n\nReturn the best matching account name, vendor name, and a short memo.`,
      temperature: 0.1,
      maxTokens: 256,
      responseFormat: 'json',
    }, rawConfig, config.fallbackChain, config.categorizationProvider || undefined, config.categorizationModel || undefined);

    const parsed = result.parsed || {};
    const confidence = parsed.confidence || 0.5;

    // Match account name to COA
    const matchedAccount = coaAccounts.find((a) => a.name.toLowerCase() === (parsed.account_name || '').toLowerCase());
    const matchedVendor = vendors.find((v) => v.displayName.toLowerCase() === (parsed.vendor_name || '').toLowerCase());

    if (matchedAccount && confidence >= config.categorizationConfidenceThreshold) {
      await db.update(bankFeedItems).set({
        suggestedAccountId: matchedAccount.id,
        suggestedContactId: matchedVendor?.id || null,
        confidenceScore: String(confidence),
        updatedAt: new Date(),
      }).where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)));
    }

    await orchestrator.completeJob(job.id, result, parsed, confidence);

    return {
      accountId: matchedAccount?.id || null,
      accountName: parsed.account_name,
      contactId: matchedVendor?.id || null,
      contactName: parsed.vendor_name,
      memo: parsed.memo,
      confidence,
      matchType: 'ai' as const,
    };
  } catch (err: any) {
    await orchestrator.failJob(job.id, err.message);
    return null;
  }
}

export async function recordUserDecision(tenantId: string, feedItemId: string, accountId: string, contactId: string | null, accepted: boolean, modified: boolean) {
  const item = await db.query.bankFeedItems.findFirst({
    where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)),
  });
  if (!item) return;

  // Verify accountId and contactId belong to this tenant before we
  // store them in categorization_history. Without this check a client
  // could poison the learning table with a cross-tenant id that would
  // later be surfaced as a suggestion (categorize() returns the stored
  // ids verbatim).
  const account = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.id, accountId)),
  });
  if (!account) throw AppError.badRequest('Account not found in this tenant');

  if (contactId) {
    const contact = await db.query.contacts.findFirst({
      where: and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId)),
    });
    if (!contact) throw AppError.badRequest('Contact not found in this tenant');
  }

  const pattern = (item.description || '').toLowerCase().trim();
  if (!pattern) return;

  // Update or create categorization history
  const existing = await db.query.categorizationHistory.findFirst({
    where: and(eq(categorizationHistory.tenantId, tenantId), eq(categorizationHistory.payeePattern, pattern)),
  });

  if (existing) {
    if (accepted && !modified) {
      // User confirmed the suggestion
      await db.update(categorizationHistory).set({
        timesConfirmed: (existing.timesConfirmed || 0) + 1,
        accountId,
        contactId,
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(categorizationHistory.id, existing.id));
    } else if (modified) {
      // User overrode to different account
      await db.update(categorizationHistory).set({
        timesOverridden: (existing.timesOverridden || 0) + 1,
        accountId, // store the user's choice
        contactId,
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(categorizationHistory.id, existing.id));
    }
  } else {
    await db.insert(categorizationHistory).values({
      tenantId,
      payeePattern: pattern,
      accountId,
      contactId,
      timesConfirmed: accepted ? 1 : 0,
      timesOverridden: modified ? 1 : 0,
    });
  }
}

export async function batchCategorize(tenantId: string, feedItemIds: string[]) {
  const results = [];
  for (const id of feedItemIds) {
    const result = await categorize(tenantId, id);
    results.push({ feedItemId: id, result });
  }
  return results;
}
