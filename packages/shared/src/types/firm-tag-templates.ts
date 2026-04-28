// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// 3-tier rules plan, Phase 7 — firm tag templates.
//
// A FirmTagTemplate is a firm-level semantic tag key (e.g.,
// "billable", "client_reimbursable"). Global rules reference
// the template_key; the per-tenant binding maps it to a real
// tags.id at fire time.

export interface FirmTagTemplate {
  id: string;
  firmId: string;
  templateKey: string;
  displayName: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TenantFirmTagBinding {
  id: string;
  firmId: string;
  tenantId: string;
  templateKey: string;
  tagId: string;
  createdAt: string;
  updatedAt: string;
}

// Aggregate the firm-admin UI uses to render a binding row with
// the human-readable tenant name (and the bound tag name when
// available).
export interface TenantFirmTagBindingWithTenant extends TenantFirmTagBinding {
  tenantName: string;
  tenantSlug: string;
  tagName: string | null;
}
