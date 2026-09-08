// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Vibe PM peer — the read side of pm_client_links used per request
// (resolveLink) plus the two discovery payloads PM renders from
// (listLinksForPeer, buildPortalContext). Everything here is built from
// the LINK, never from any "current session" notion.

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  pmClientLinks, firms, tenants, companies, tenantFirmAssignments,
  portalContacts, portalContactCompanies, portalSettingsPerCompany,
} from '../db/schema/index.js';
import * as flags from './feature-flags.service.js';
import { getPracticeSettings } from './portal-contact.service.js';

export interface ResolvedPeerLink {
  id: string;
  firmId: string;
  pmClientId: string;
  tenantId: string;
  companyId: string;
  contactId: string;
  contact: { email: string; firstName: string | null; lastName: string | null };
}

/** The per-company grants PM inherits from the linked contact. */
export interface PeerPermissions {
  financialsAccess: boolean;
  filesAccess: boolean;
  questionsForUsAccess: boolean;
  bankingAccess: boolean;
  billPayAccess: boolean;
  categorizeAccess: boolean;
  bankRepairAccess: boolean;
}

/** Effective features = tenant flag AND the contact's grant. Questions
 *  and receipts have no tenant flag (always available to a linked contact). */
export interface PeerFeatures {
  questions: boolean;
  questionsForUs: boolean;
  financials: boolean;
  receipts: boolean;
  documentRequests: boolean;
  banking: boolean;
  bankRepair: boolean;
  billPay: boolean;
  categorize: boolean;
}

export interface PeerPortalContext {
  pmClientId: string;
  tenant: { id: string; name: string; slug: string };
  company: { id: string; name: string };
  contact: { id: string; email: string; firstName: string | null; lastName: string | null };
  permissions: PeerPermissions;
  features: PeerFeatures;
  practice: {
    name: string;
    brandingLogoUrl: string | null;
    brandingPrimaryColor: string | null;
    announcement: string | null;
  };
}

export interface PeerLinkSummary {
  id: string;
  pmClientId: string;
  tenant: { id: string; name: string };
  company: { id: string; name: string };
  contact: { id: string; email: string; firstName: string | null; lastName: string | null; status: string };
  active: boolean;
  createdAt: string;
}

/**
 * Every condition that must hold for the peer to act as the linked
 * contact, re-checked on each request (staff may pause a contact, a
 * tenant may leave the firm, the company may be unlinked — all of
 * those take effect immediately). Any failure → null (uniform 404).
 */
export async function resolveLink(firmId: string, pmClientId: string): Promise<ResolvedPeerLink | null> {
  const [row] = await db
    .select({
      id: pmClientLinks.id,
      firmId: pmClientLinks.firmId,
      pmClientId: pmClientLinks.pmClientId,
      tenantId: pmClientLinks.tenantId,
      companyId: pmClientLinks.companyId,
      contactId: pmClientLinks.contactId,
      firmActive: firms.isActive,
      companyTenantId: companies.tenantId,
      contactTenantId: portalContacts.tenantId,
      contactStatus: portalContacts.status,
      email: portalContacts.email,
      firstName: portalContacts.firstName,
      lastName: portalContacts.lastName,
    })
    .from(pmClientLinks)
    .innerJoin(firms, eq(firms.id, pmClientLinks.firmId))
    .innerJoin(tenants, eq(tenants.id, pmClientLinks.tenantId))
    .innerJoin(companies, eq(companies.id, pmClientLinks.companyId))
    .innerJoin(portalContacts, eq(portalContacts.id, pmClientLinks.contactId))
    .where(and(eq(pmClientLinks.firmId, firmId), eq(pmClientLinks.pmClientId, pmClientId)))
    .limit(1);
  if (!row) return null;
  if (!row.firmActive) return null;
  if (row.companyTenantId !== row.tenantId || row.contactTenantId !== row.tenantId) return null;
  if (row.contactStatus !== 'active') return null;

  const [assignment] = await db
    .select({ id: tenantFirmAssignments.id })
    .from(tenantFirmAssignments)
    .where(and(
      eq(tenantFirmAssignments.tenantId, row.tenantId),
      eq(tenantFirmAssignments.firmId, firmId),
      eq(tenantFirmAssignments.isActive, true),
    ))
    .limit(1);
  if (!assignment) return null;

  const [pcc] = await db
    .select({ contactId: portalContactCompanies.contactId })
    .from(portalContactCompanies)
    .where(and(eq(portalContactCompanies.contactId, row.contactId), eq(portalContactCompanies.companyId, row.companyId)))
    .limit(1);
  if (!pcc) return null;

  const [settings] = await db
    .select({ paused: portalSettingsPerCompany.paused })
    .from(portalSettingsPerCompany)
    .where(eq(portalSettingsPerCompany.companyId, row.companyId))
    .limit(1);
  if (settings?.paused) return null;

  return {
    id: row.id,
    firmId: row.firmId,
    pmClientId: row.pmClientId,
    tenantId: row.tenantId,
    companyId: row.companyId,
    contactId: row.contactId,
    contact: { email: row.email, firstName: row.firstName, lastName: row.lastName },
  };
}

async function loadPermissions(contactId: string, companyId: string): Promise<PeerPermissions> {
  const [pcc] = await db
    .select()
    .from(portalContactCompanies)
    .where(and(eq(portalContactCompanies.contactId, contactId), eq(portalContactCompanies.companyId, companyId)))
    .limit(1);
  return {
    financialsAccess: pcc?.financialsAccess ?? false,
    filesAccess: pcc?.filesAccess ?? false,
    questionsForUsAccess: pcc?.questionsForUsAccess ?? false,
    bankingAccess: pcc?.bankingAccess ?? false,
    billPayAccess: pcc?.billPayAccess ?? false,
    categorizeAccess: pcc?.categorizeAccess ?? false,
    bankRepairAccess: pcc?.bankRepairAccess ?? false,
  };
}

async function computeFeatures(tenantId: string, p: PeerPermissions): Promise<PeerFeatures> {
  const [banking, billPay, categorize, docReq] = await Promise.all([
    flags.isEnabled(tenantId, 'PORTAL_BANKING_V1'),
    flags.isEnabled(tenantId, 'PORTAL_BILL_PAY_V1'),
    flags.isEnabled(tenantId, 'PORTAL_CATEGORIZE_V1'),
    flags.isEnabled(tenantId, 'RECURRING_DOC_REQUESTS_V1'),
  ]);
  return {
    questions: true,
    questionsForUs: p.questionsForUsAccess,
    financials: p.financialsAccess,
    receipts: p.filesAccess,
    documentRequests: docReq,
    banking: banking && p.bankingAccess,
    bankRepair: banking && p.bankRepairAccess,
    billPay: billPay && p.billPayAccess,
    categorize: categorize && p.categorizeAccess,
  };
}

export async function buildPortalContext(link: ResolvedPeerLink): Promise<PeerPortalContext> {
  const [tenant] = await db.select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
    .from(tenants).where(eq(tenants.id, link.tenantId)).limit(1);
  const [company] = await db.select({ id: companies.id, name: companies.businessName })
    .from(companies).where(eq(companies.id, link.companyId)).limit(1);
  const permissions = await loadPermissions(link.contactId, link.companyId);
  const [features, practice] = await Promise.all([
    computeFeatures(link.tenantId, permissions),
    getPracticeSettings(link.tenantId),
  ]);
  return {
    pmClientId: link.pmClientId,
    tenant: { id: link.tenantId, name: tenant?.name ?? '', slug: tenant?.slug ?? '' },
    company: { id: link.companyId, name: company?.name ?? '' },
    contact: { id: link.contactId, ...link.contact },
    permissions,
    features,
    practice: {
      name: tenant?.name ?? '',
      brandingLogoUrl: practice.brandingLogoUrl,
      brandingPrimaryColor: practice.brandingPrimaryColor,
      announcement: practice.announcementEnabled ? practice.announcementText : null,
    },
  };
}

/** Every link for the firm with a computed `active` flag (same rules as
 *  resolveLink) — used by PM's discovery call and the firm's Linked-clients card. */
export async function listLinksForFirm(firmId: string): Promise<PeerLinkSummary[]> {
  const rows = await db
    .select({
      id: pmClientLinks.id,
      pmClientId: pmClientLinks.pmClientId,
      tenantId: pmClientLinks.tenantId,
      tenantName: tenants.name,
      companyId: pmClientLinks.companyId,
      companyName: companies.businessName,
      companyTenantId: companies.tenantId,
      contactId: pmClientLinks.contactId,
      contactTenantId: portalContacts.tenantId,
      email: portalContacts.email,
      firstName: portalContacts.firstName,
      lastName: portalContacts.lastName,
      status: portalContacts.status,
      createdAt: pmClientLinks.createdAt,
    })
    .from(pmClientLinks)
    .innerJoin(tenants, eq(tenants.id, pmClientLinks.tenantId))
    .innerJoin(companies, eq(companies.id, pmClientLinks.companyId))
    .innerJoin(portalContacts, eq(portalContacts.id, pmClientLinks.contactId))
    .where(eq(pmClientLinks.firmId, firmId))
    .orderBy(tenants.name, companies.businessName);
  if (rows.length === 0) return [];

  const tenantIds = [...new Set(rows.map((r) => r.tenantId))];
  const managed = new Set((await db
    .select({ tenantId: tenantFirmAssignments.tenantId })
    .from(tenantFirmAssignments)
    .where(and(
      eq(tenantFirmAssignments.firmId, firmId),
      eq(tenantFirmAssignments.isActive, true),
      inArray(tenantFirmAssignments.tenantId, tenantIds),
    ))).map((r) => r.tenantId));
  const contactIds = rows.map((r) => r.contactId);
  const linked = new Set((await db
    .select({ contactId: portalContactCompanies.contactId, companyId: portalContactCompanies.companyId })
    .from(portalContactCompanies)
    .where(inArray(portalContactCompanies.contactId, contactIds))).map((r) => `${r.contactId}:${r.companyId}`));
  const companyIds = rows.map((r) => r.companyId);
  const paused = new Set((await db
    .select({ companyId: portalSettingsPerCompany.companyId })
    .from(portalSettingsPerCompany)
    .where(and(inArray(portalSettingsPerCompany.companyId, companyIds), eq(portalSettingsPerCompany.paused, true)))).map((r) => r.companyId));

  return rows.map((r) => ({
    id: r.id,
    pmClientId: r.pmClientId,
    tenant: { id: r.tenantId, name: r.tenantName },
    company: { id: r.companyId, name: r.companyName },
    contact: { id: r.contactId, email: r.email, firstName: r.firstName, lastName: r.lastName, status: r.status },
    active: managed.has(r.tenantId)
      && r.companyTenantId === r.tenantId
      && r.contactTenantId === r.tenantId
      && r.status === 'active'
      && linked.has(`${r.contactId}:${r.companyId}`)
      && !paused.has(r.companyId),
    createdAt: r.createdAt.toISOString(),
  }));
}
