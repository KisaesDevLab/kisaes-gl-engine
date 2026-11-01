// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

export type EntityType = 'sole_prop' | 'single_member_llc' | 's_corp' | 'c_corp' | 'partnership';
export type AccountingMethod = 'cash' | 'accrual';
export type PaymentTerms = 'due_on_receipt' | 'net_15' | 'net_30' | 'net_60' | 'net_90' | 'custom';
export type CategoryFilterMode = 'by_type' | 'all';

export interface Company {
  id: string;
  tenantId: string;
  businessName: string;
  legalName: string | null;
  ein: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  logoUrl: string | null;
  industry: string | null;
  entityType: EntityType;
  fiscalYearStartMonth: number;
  accountingMethod: AccountingMethod;
  defaultPaymentTerms: PaymentTerms;
  invoicePrefix: string;
  invoiceNextNumber: number;
  defaultSalesTaxRate: string;
  currency: string;
  dateFormat: string;
  categoryFilterMode: CategoryFilterMode;
  setupComplete: boolean;
  createdAt: string;
  updatedAt: string;
  mcpEnabled?: boolean;
}

export interface UpdateCompanyInput {
  businessName?: string;
  legalName?: string | null;
  ein?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  industry?: string | null;
  entityType?: EntityType;
  fiscalYearStartMonth?: number;
  accountingMethod?: AccountingMethod;
  defaultPaymentTerms?: PaymentTerms;
  invoicePrefix?: string;
  invoiceNextNumber?: number;
  defaultSalesTaxRate?: string;
  currency?: string;
  dateFormat?: string;
  categoryFilterMode?: CategoryFilterMode;
  mcpEnabled?: boolean;
}

import type { LineEntryMode } from './items.js';

export interface CompanySettings {
  fiscalYearStartMonth: number;
  accountingMethod: AccountingMethod;
  defaultPaymentTerms: PaymentTerms;
  invoicePrefix: string;
  invoiceNextNumber: number;
  defaultSalesTaxRate: string;
  currency: string;
  dateFormat: string;
  categoryFilterMode: CategoryFilterMode;
  defaultLineEntryMode?: LineEntryMode;
  lockDate?: string | null;
  chatSupportEnabled?: boolean;
  /** Default account for early-payment discounts taken in Pay Bills (bill-discounts-v1); null = none. */
  billDiscountAccountId?: string | null;
  /** Income account billable-cost markups post to (billable-costs-v1); null = none. */
  billableMarkupAccountId?: string | null;
  /** Bounced payments (payment-bounce-v1): bank fee expense account; null = none. */
  nsfBankFeeAccountId?: string | null;
  /** Bounced payments: income account of the fee charged to the client; null = none. */
  nsfFeeIncomeAccountId?: string | null;
  /** Bounced payments: the fee charged to the client, 2-place string; null = not set. */
  nsfCustomerFee?: string | null;
  /** Receive Payment write-off account (payment-settle-v1); null = none. */
  writeOffAccountId?: string | null;
  /** Shortfall at or under which a write-off is suggested, 2-place string; null = never. */
  writeOffThreshold?: string | null;
  /** Receive Payment early-discount account (payment-discounts-v1); null = none. */
  salesDiscountAccountId?: string | null;
}
