// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

export interface BankRule {
  id: string;
  tenantId: string;
  name: string;
  priority: number;
  isActive: boolean;
  applyTo: 'deposits' | 'expenses' | 'both';
  bankAccountId: string | null;
  descriptionContains: string | null;
  descriptionExact: string | null;
  amountEquals: string | null;
  amountMin: string | null;
  amountMax: string | null;
  assignAccountId: string | null;
  assignContactId: string | null;
  assignMemo: string | null;
  autoConfirm: boolean;
  timesApplied: number;
  lastAppliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBankRuleInput {
  name: string;
  applyTo?: 'deposits' | 'expenses' | 'both';
  bankAccountId?: string | null;
  descriptionContains?: string | null;
  descriptionExact?: string | null;
  amountEquals?: string | null;
  amountMin?: string | null;
  amountMax?: string | null;
  assignAccountId?: string | null;
  assignContactId?: string | null;
  assignMemo?: string | null;
  autoConfirm?: boolean;
  priority?: number;
}

export type UpdateBankRuleInput = Partial<CreateBankRuleInput> & { isActive?: boolean };
