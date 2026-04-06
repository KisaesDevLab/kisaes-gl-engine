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
}

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
}
