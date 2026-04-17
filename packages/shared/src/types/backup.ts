// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

export interface BackupMetadata {
  backup_type: 'system' | 'tenant';
  version: string;
  source_version: string;
  created_at: string;
  created_by?: string;
  encryption_method: 'passphrase_pbkdf2_aes256gcm' | 'server_key_aes256gcm';
  company_name?: string;
  fiscal_year_start?: number;
  tenant_count?: number;
  user_count?: number;
  transaction_count: number;
  date_range?: { from: string; to: string };
  checksum: string;
}

export interface TenantExportData {
  metadata: BackupMetadata;
  company: Record<string, unknown>;
  chart_of_accounts: Record<string, unknown>[];
  contacts: Record<string, unknown>[];
  transactions: Record<string, unknown>[];
  journal_lines: Record<string, unknown>[];
  invoices: Record<string, unknown>[];
  invoice_lines: Record<string, unknown>[];
  bills: Record<string, unknown>[];
  bill_lines: Record<string, unknown>[];
  bill_payments: Record<string, unknown>[];
  vendor_credits: Record<string, unknown>[];
  vendor_credit_lines: Record<string, unknown>[];
  bank_rules: Record<string, unknown>[];
  categorization_history: Record<string, unknown>[];
  tags: Record<string, unknown>[];
  tag_groups: Record<string, unknown>[];
  tag_assignments: Record<string, unknown>[];
  items: Record<string, unknown>[];
  budgets: Record<string, unknown>[];
  budget_lines: Record<string, unknown>[];
  recurring_templates: Record<string, unknown>[];
  recurring_template_lines: Record<string, unknown>[];
  audit_trail: Record<string, unknown>[];
  attachments: Array<{
    id: string;
    file_name: string;
    mime_type: string;
    size: number;
    linked_entity_type: string;
    linked_entity_id: string;
  }>;
}

export interface TenantExportPreview {
  company_name: string;
  source_version: string;
  export_date: string;
  date_range?: { from: string; to: string };
  counts: {
    accounts: number;
    contacts: number;
    transactions: number;
    invoices: number;
    bills: number;
    attachments: number;
    tags: number;
    items: number;
    budgets: number;
    bank_rules: number;
  };
  file_size: number;
  validation_token: string;
}

export interface ImportResult {
  company_name: string;
  tenant_id: string;
  counts: {
    accounts: number;
    contacts: number;
    transactions: number;
    journal_lines: number;
    invoices: number;
    bills: number;
    attachments: number;
    tags: number;
    items: number;
    budgets: number;
    bank_rules: number;
    audit_entries: number;
  };
  warnings: string[];
  duplicate_flags: number;
}

export interface ImportProgress {
  status: 'processing' | 'completed' | 'failed';
  step: string;
  progress: number; // 0-100
  detail?: string;
  result?: ImportResult;
  error?: string;
}

export interface RemoteBackupConfig {
  destination: 'sftp' | 'webdav' | 'email';
  schedule: 'daily' | 'weekly' | 'monthly';
  retention_count: number;
  sftp?: {
    host: string;
    port: number;
    username: string;
    auth_method: 'password' | 'key';
    password?: string;
    remote_path: string;
  };
  webdav?: {
    url: string;
    username: string;
    password?: string;
  };
  email?: {
    recipient: string;
    max_size_mb: number;
  };
}

export interface RemoteBackupHistoryEntry {
  id: string;
  timestamp: string;
  destination: string;
  status: 'success' | 'failed';
  size?: number;
  error?: string;
}
