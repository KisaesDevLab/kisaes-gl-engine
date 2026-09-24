// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

export type ContactType = 'customer' | 'vendor' | 'both';

export interface Contact {
  id: string;
  tenantId: string;
  contactType: ContactType;
  displayName: string;
  companyName: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  billingLine1: string | null;
  billingLine2: string | null;
  billingCity: string | null;
  billingState: string | null;
  billingZip: string | null;
  billingCountry: string;
  shippingLine1: string | null;
  shippingLine2: string | null;
  shippingCity: string | null;
  shippingState: string | null;
  shippingZip: string | null;
  shippingCountry: string;
  defaultPaymentTerms: string | null;
  openingBalance: string;
  openingBalanceDate: string | null;
  defaultExpenseAccountId: string | null;
  /**
   * Server-enriched on LIST responses only (joined from accounts): the
   * default expense category's name and number, for the Contacts table.
   * Absent on single-contact reads and on create/update results.
   */
  defaultExpenseAccountName?: string | null;
  defaultExpenseAccountNumber?: string | null;
  // ADR 0XY — vendor-scoped default tag.
  defaultTagId: string | null;
  taxId: string | null;
  /** Account number the vendor assigned to us; free text. Seeds check memos. */
  vendorAccountNumber: string | null;
  is1099Eligible: boolean;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateContactInput {
  contactType: ContactType;
  displayName: string;
  companyName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  billingLine1?: string | null;
  billingLine2?: string | null;
  billingCity?: string | null;
  billingState?: string | null;
  billingZip?: string | null;
  billingCountry?: string;
  shippingLine1?: string | null;
  shippingLine2?: string | null;
  shippingCity?: string | null;
  shippingState?: string | null;
  shippingZip?: string | null;
  shippingCountry?: string;
  defaultPaymentTerms?: string | null;
  openingBalance?: string;
  openingBalanceDate?: string | null;
  defaultExpenseAccountId?: string | null;
  defaultTagId?: string | null;
  taxId?: string | null;
  vendorAccountNumber?: string | null;
  is1099Eligible?: boolean;
  notes?: string | null;
}

export interface UpdateContactInput {
  contactType?: ContactType;
  displayName?: string;
  companyName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  billingLine1?: string | null;
  billingLine2?: string | null;
  billingCity?: string | null;
  billingState?: string | null;
  billingZip?: string | null;
  billingCountry?: string;
  shippingLine1?: string | null;
  shippingLine2?: string | null;
  shippingCity?: string | null;
  shippingState?: string | null;
  shippingZip?: string | null;
  shippingCountry?: string;
  defaultPaymentTerms?: string | null;
  defaultExpenseAccountId?: string | null;
  defaultTagId?: string | null;
  taxId?: string | null;
  vendorAccountNumber?: string | null;
  is1099Eligible?: boolean;
  notes?: string | null;
  isActive?: boolean;
}

export interface ContactFilters {
  contactType?: ContactType;
  isActive?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}
