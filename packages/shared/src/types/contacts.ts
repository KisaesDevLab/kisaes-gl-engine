// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

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
  taxId: string | null;
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
  taxId?: string | null;
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
  taxId?: string | null;
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
