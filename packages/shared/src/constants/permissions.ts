// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { AccessLevel, ResourceDef } from '../types/permissions.js';

// The rows of the permission matrix — the app's user-facing feature
// surfaces. Order + grouping mirror the Sidebar `navGroups` so the
// Team-page editor renders in the same shape the user navigates.
//
// Keep in sync with:
//   - Sidebar `navGroups` (packages/web/.../Sidebar.tsx)
//   - the `requireResource(<key>)` guards on each domain router
//
// `writable: false` = read-only surface (only none/view apply).
export const PERMISSION_GROUPS = [
  'Transactions',
  'Sales',
  'Payables',
  'Payroll',
  'Checks',
  'Banking',
  'Reporting',
  'Manage',
] as const;
export type PermissionGroup = typeof PERMISSION_GROUPS[number];

export const PERMISSION_RESOURCES = [
  // Transactions
  { key: 'transactions', label: 'Transactions', group: 'Transactions', writable: true },
  { key: 'batch_entry', label: 'Batch Entry', group: 'Transactions', writable: true },
  { key: 'recurring', label: 'Recurring Transactions', group: 'Transactions', writable: true },
  { key: 'duplicates', label: 'Duplicates', group: 'Transactions', writable: true },
  { key: 'bulk_import', label: 'Bulk Import', group: 'Transactions', writable: true },
  // Sales
  { key: 'invoices', label: 'Invoices', group: 'Sales', writable: true },
  { key: 'receive_payment', label: 'Receive Payment', group: 'Sales', writable: true },
  { key: 'estimates', label: 'Estimates', group: 'Sales', writable: true },
  { key: 'items', label: 'Items', group: 'Sales', writable: true },
  // Payables
  { key: 'bills', label: 'Bills', group: 'Payables', writable: true },
  { key: 'pay_bills', label: 'Pay Bills', group: 'Payables', writable: true },
  { key: 'vendor_credits', label: 'Vendor Credits', group: 'Payables', writable: true },
  // Payroll
  { key: 'payroll_import', label: 'Payroll Import', group: 'Payroll', writable: true },
  // Checks
  { key: 'checks', label: 'Checks', group: 'Checks', writable: true },
  // Banking — one resource covering the whole banking router (feed,
  // categorize/match, statement import, deposits, reconcile).
  { key: 'banking', label: 'Banking', group: 'Banking', writable: true },
  { key: 'daily_sales', label: 'Daily Sales (POS)', group: 'Banking', writable: true },
  // Reporting
  { key: 'reports', label: 'Reports', group: 'Reporting', writable: false },
  { key: 'budgets', label: 'Budgets', group: 'Reporting', writable: true },
  { key: 'dashboard', label: 'Dashboard', group: 'Reporting', writable: false },
  // Manage
  { key: 'accounts', label: 'Chart of Accounts', group: 'Manage', writable: true },
  { key: 'contacts', label: 'Contacts', group: 'Manage', writable: true },
  { key: 'attachments', label: 'Attachments', group: 'Manage', writable: true },
  { key: 'tags', label: 'Tags', group: 'Manage', writable: true },
  { key: 'company_settings', label: 'Company Settings', group: 'Manage', writable: true },
  { key: 'ai_chat', label: 'AI Assistant', group: 'Manage', writable: true },
  { key: 'audit_log', label: 'Audit Log', group: 'Manage', writable: false },
] as const satisfies readonly ResourceDef[];

export type ResourceKey = typeof PERMISSION_RESOURCES[number]['key'];

export const RESOURCE_KEYS: readonly ResourceKey[] = PERMISSION_RESOURCES.map((r) => r.key);

export function isResourceKey(key: string): key is ResourceKey {
  return (RESOURCE_KEYS as readonly string[]).includes(key);
}

export function getResourceDef(key: ResourceKey): ResourceDef {
  // Safe: key is a catalog member by construction.
  return PERMISSION_RESOURCES.find((r) => r.key === key) as ResourceDef;
}

// A partial map is the wire/storage shape (templates + overrides).
// Absent keys resolve to `none` (deny-by-default) inside the resolver.
export type PermissionMap = Partial<Record<ResourceKey, AccessLevel>>;

// A fully-resolved map — every resource has a concrete level. This is
// what `resolveEffectivePermissions` returns and what `/auth/me` ships.
export type EffectivePermissions = Record<ResourceKey, AccessLevel>;
