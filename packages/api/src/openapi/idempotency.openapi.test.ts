// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * E20 (U-18): the idempotency-v1 route set (plus idempotency-ap-v1, the A/P
 * routes keyed after it) in the OpenAPI document. Exactly
 * these operations carry the Idempotency-Key header parameter and
 * `x-idempotency: true` (clients upgrade their retry behaviour per route on
 * it), and the capability is advertised. Needs no database.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { loadEngineSpec } from './engine-spec.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

type Param = { name: string; in: string; required?: boolean; schema?: { pattern?: string } };
type Operation = { parameters?: Param[]; 'x-idempotency'?: boolean };
type Paths = Record<string, Record<string, Operation>>;

/** The idempotency-v1 set (append-only under a new name). */
export const IDEMPOTENCY_V1_ROUTES = [
  'post /api/v1/transactions',
  'put /api/v1/transactions/{id}',
  'post /api/v1/transactions/{id}/void',
  'delete /api/v1/transactions/{id}',
  'post /api/v1/checks',
  'put /api/v1/checks/{id}',
  'post /api/v1/invoices',
  'post /api/v1/bills',
  'post /api/v1/daily-sales/entries',
  'post /api/v1/daily-sales/entries/{id}/post',
  'post /api/v1/daily-sales/entries/{id}/void',
  'post /api/v1/templates',
  'post /api/v1/templates/from-transaction',
  'post /api/v1/templates/{id}/enter',
  'post /api/v1/templates/{id}/occurrences/{date}/skip',
  'post /api/v1/templates/{id}/occurrences/{date}/resolve',
  'post /api/v1/accounts',
  'post /api/v1/contacts',
  'post /api/v1/items',
  'post /api/v1/tags',
].sort();

/** The idempotency-ap-v1 set: A/P routes keyed after idempotency-v1 (U-83..U-87 fix pass). */
export const IDEMPOTENCY_AP_V1_ROUTES = [
  'put /api/v1/bills/{id}',
  'post /api/v1/bills/{id}/void',
  'post /api/v1/vendor-credits',
  'put /api/v1/vendor-credits/{id}',
  'post /api/v1/vendor-credits/{id}/void',
  'post /api/v1/bill-payments/{id}/void',
].sort();

/** The idempotency-docs-v1 set: document draft create and convert (U-92a). */
export const IDEMPOTENCY_DOCS_V1_ROUTES = [
  'post /api/v1/document-drafts',
  'post /api/v1/document-drafts/{id}/convert',
].sort();

/** Keyed by document-drafts-attach-v1, with idempotency-docs-v1's contract (U-95). */
export const IDEMPOTENCY_DOCS_ATTACH_V1_ROUTES = [
  'post /api/v1/document-drafts/{id}/attach',
].sort();

/** The idempotency-pay-bills-v1 set: Pay Bills (U-102). */
export const IDEMPOTENCY_PAY_BILLS_V1_ROUTES = [
  'post /api/v1/bill-payments',
].sort();

/** The idempotency-check-print-v1 set: check printing (U-116). */
export const IDEMPOTENCY_CHECK_PRINT_V1_ROUTES = [
  'post /api/v1/checks/print',
].sort();

/** The idempotency-invoice-v1 set: invoice edit, void and sent (U-124). */
export const IDEMPOTENCY_INVOICE_V1_ROUTES = [
  'put /api/v1/invoices/{id}',
  'post /api/v1/invoices/{id}/void',
  'post /api/v1/invoices/{id}/sent',
].sort();

/** Keyed by invoice-email-v1, with idempotency-v1's contract (U-127). */
export const IDEMPOTENCY_INVOICE_EMAIL_V1_ROUTES = [
  'post /api/v1/invoices/{id}/email',
  'post /api/v1/invoices/{id}/email-later',
].sort();

/** Keyed by idempotency-receive-payment-v1, with idempotency-v1's contract (U-132). */
export const IDEMPOTENCY_RECEIVE_PAYMENT_V1_ROUTES = [
  'post /api/v1/payments/receive',
  'put /api/v1/payments/{id}',
  'post /api/v1/payments/{id}/void',
  'post /api/v1/payments/unapply',
  'post /api/v1/payments/{id}/bounce',
  // payment-settle-v1 (U-133).
  'post /api/v1/payments/{id}/apply',
  'post /api/v1/customer-refunds',
].sort();

/** Keyed by idempotency-credit-memo-v1, with idempotency-v1's contract (U-137). */
export const IDEMPOTENCY_CREDIT_MEMO_V1_ROUTES = [
  'post /api/v1/credit-memos/{id}/apply',
  'post /api/v1/credit-memos/{id}/unapply',
  // U-138 / U-143.
  'post /api/v1/credit-memos',
  'put /api/v1/credit-memos/{id}',
  'post /api/v1/sales-receipts',
  'put /api/v1/sales-receipts/{id}',
].sort();

/** Keyed by idempotency-finance-charges-v1 (U-141). */
export const IDEMPOTENCY_FINANCE_CHARGES_V1_ROUTES = ['post /api/v1/finance-charges/assess'];

/** Keyed by idempotency-customer-statements-v1 (U-140). */
export const IDEMPOTENCY_CUSTOMER_STATEMENTS_V1_ROUTES = [
  'post /api/v1/customer-statement-runs',
  'post /api/v1/customer-statements/{id}/sent',
  'post /api/v1/customer-statements/{id}/email',
  'post /api/v1/customer-statements/{id}/email-later',
].sort();

/** Keyed by sales-doc-email-v1, with idempotency-v1's contract (U-144). */
export const IDEMPOTENCY_SALES_DOC_EMAIL_V1_ROUTES = [
  'post /api/v1/credit-memos/{id}/email',
  'post /api/v1/credit-memos/{id}/email-later',
  'post /api/v1/sales-receipts/{id}/email',
  'post /api/v1/sales-receipts/{id}/email-later',
].sort();

/** Keyed by idempotency-sales-tax-v1 (U-147): the /sales-tax setup writes. */
export const IDEMPOTENCY_SALES_TAX_V1_ROUTES = ['agencies', 'items', 'codes', 'exemptions'].flatMap((r) => [
  `post /api/v1/sales-tax/${r}`,
  `put /api/v1/sales-tax/${r}/{id}`,
  `post /api/v1/sales-tax/${r}/{id}/deactivate`,
  `post /api/v1/sales-tax/${r}/{id}/reactivate`,
]).sort();

/** Keyed by idempotency-sales-tax-pay-v1 (U-150): Pay Sales Tax, link, unlink, mark paid through. */
export const IDEMPOTENCY_SALES_TAX_PAY_V1_ROUTES = [
  'post /api/v1/sales-tax/payments',
  'post /api/v1/sales-tax/payments/link',
  'post /api/v1/sales-tax/payments/{id}/unlink',
  'post /api/v1/sales-tax/payments/mark-paid-through',
  'post /api/v1/sales-tax/payments/mark-paid-through/{runId}/undo',
].sort();

/** Keyed by idempotency-recovery-v1 (U-154): record a recovered bad debt. */
export const IDEMPOTENCY_RECOVERY_V1_ROUTES = ['post /api/v1/payments/write-off-recoveries'];

/** Keyed by inventory-adjust-v1, with idempotency-v1's contract (U-159): adjustments and counts. */
export const IDEMPOTENCY_INVENTORY_V1_ROUTES = [
  'post /api/v1/inventory/adjustments',
  'put /api/v1/inventory/adjustments/{id}',
  'post /api/v1/inventory/adjustments/{id}/void',
  'delete /api/v1/inventory/adjustments/{id}',
  'post /api/v1/inventory/counts',
].sort();

/** Keyed by units-of-measure-v1, with idempotency-v1's contract (U-161): create a unit set. */
export const IDEMPOTENCY_UNIT_SETS_V1_ROUTES = ['post /api/v1/unit-sets'];

/** Keyed by bank-import-batch-v1 (U-06): a commit needs the key; undo takes one. */
export const IDEMPOTENCY_BANK_IMPORT_V1_ROUTES = [
  'post /api/v1/banking/feed/import-batch',
  'delete /api/v1/banking/feed/import-batches/{id}',
].sort();

/** Keyed by feed-match-post-v1, with idempotency-v1's contract (U-171): both need the key. */
export const IDEMPOTENCY_FEED_MATCH_POST_V1_ROUTES = [
  'post /api/v1/banking/feed/{id}/transfer',
  'post /api/v1/banking/feed/{id}/deposit',
].sort();

const ALL_KEYED_ROUTES = [
  ...IDEMPOTENCY_FEED_MATCH_POST_V1_ROUTES,
  ...IDEMPOTENCY_BANK_IMPORT_V1_ROUTES,
  ...IDEMPOTENCY_UNIT_SETS_V1_ROUTES,
  ...IDEMPOTENCY_INVENTORY_V1_ROUTES,
  ...IDEMPOTENCY_SALES_TAX_V1_ROUTES, ...IDEMPOTENCY_SALES_TAX_PAY_V1_ROUTES, ...IDEMPOTENCY_RECOVERY_V1_ROUTES,
  ...IDEMPOTENCY_V1_ROUTES, ...IDEMPOTENCY_AP_V1_ROUTES, ...IDEMPOTENCY_DOCS_V1_ROUTES, ...IDEMPOTENCY_DOCS_ATTACH_V1_ROUTES,
  ...IDEMPOTENCY_PAY_BILLS_V1_ROUTES, ...IDEMPOTENCY_CHECK_PRINT_V1_ROUTES, ...IDEMPOTENCY_INVOICE_V1_ROUTES,
  ...IDEMPOTENCY_INVOICE_EMAIL_V1_ROUTES, ...IDEMPOTENCY_RECEIVE_PAYMENT_V1_ROUTES, ...IDEMPOTENCY_CREDIT_MEMO_V1_ROUTES, ...IDEMPOTENCY_CUSTOMER_STATEMENTS_V1_ROUTES,
  ...IDEMPOTENCY_FINANCE_CHARGES_V1_ROUTES, ...IDEMPOTENCY_SALES_DOC_EMAIL_V1_ROUTES,
].sort();

let paths: Paths;

beforeAll(async () => {
  const spec = await loadEngineSpec();
  paths = spec.doc['paths'] as Paths;
}, 120_000);

describe('idempotency-v1 in openapi.json', () => {
  it('exactly the route set carries x-idempotency and the Idempotency-Key header', () => {
    const marked: string[] = [];
    const withHeader: string[] = [];
    for (const [path, ops] of Object.entries(paths)) {
      for (const [method, op] of Object.entries(ops)) {
        if (op['x-idempotency'] === true) marked.push(`${method} ${path}`);
        const h = (op.parameters ?? []).find((p) => p.in === 'header' && p.name === 'Idempotency-Key');
        if (h) {
          withHeader.push(`${method} ${path}`);
          expect(h.required).toBe(false);
          expect(h.schema?.pattern).toBe('^[A-Za-z0-9_-]{16,64}$');
        }
      }
    }
    expect(marked.sort()).toEqual(ALL_KEYED_ROUTES);
    expect(withHeader.sort()).toEqual(ALL_KEYED_ROUTES);
  });

  it('POST /bill-payments (Pay Bills) is keyed (idempotency-pay-bills-v1)', () => {
    expect(paths['/api/v1/bill-payments']?.['post']?.['x-idempotency']).toBe(true);
  });

  it('/batch/save and tenant creation are not in the set', () => {
    expect(paths['/api/v1/batch/save']?.['post']?.['x-idempotency']).toBeUndefined();
    expect(paths['/api/v1/auth/create-tenant']?.['post']?.['x-idempotency']).toBeUndefined();
    expect(paths['/api/v1/tenants']?.['post']?.['x-idempotency']).toBeUndefined();
  });

  it('the capability is advertised', () => {
    expect(DESKTOP_CAPABILITIES).toContain('idempotency-v1');
    expect(DESKTOP_CAPABILITIES).toContain('idempotency-recovery-v1');
    expect(DESKTOP_CAPABILITIES).toContain('batch-idempotent-v1');
    expect(DESKTOP_CAPABILITIES).toContain('idempotency-ap-v1');
    expect(DESKTOP_CAPABILITIES).toContain('idempotency-docs-v1');
    expect(DESKTOP_CAPABILITIES).toContain('document-drafts-attach-v1');
    expect(DESKTOP_CAPABILITIES).toContain('idempotency-pay-bills-v1');
    expect(DESKTOP_CAPABILITIES).toContain('idempotency-check-print-v1');
    expect(DESKTOP_CAPABILITIES).toContain('idempotency-invoice-v1');
    expect(DESKTOP_CAPABILITIES).toContain('invoice-email-v1');
    expect(DESKTOP_CAPABILITIES).toContain('idempotency-receive-payment-v1');
    expect(DESKTOP_CAPABILITIES).toContain('idempotency-credit-memo-v1');
    expect(DESKTOP_CAPABILITIES).toContain('sales-doc-email-v1');
    expect(DESKTOP_CAPABILITIES).toContain('inventory-adjust-v1');
  });
});
