// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Report-letter service: variable resolution (basis-aware), letter content
// substitution, and that a report pack persists a selected letter id. Uses
// the shared test DB; report_letters is system-level (no tenant), so cleanup
// only removes rows this suite creates — the seeded SSARS-21 defaults stay.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq, inArray, like } from 'drizzle-orm';

// Stub the enqueue so createPack's sibling run path never opens Redis.
vi.mock('./extraction/queue.js', () => ({
  enqueueReportPack: vi.fn(async () => undefined),
}));

import { db } from '../db/index.js';
import { tenants, companies, reportLetters, reportPacks, reportPackItems, auditLog } from '../db/schema/index.js';
import * as letterService from './report-letter.service.js';
import * as packService from './report-pack.service.js';

const NAME_PREFIX = 'ZZ-letter-test-';
const USER_ID = '00000000-0000-4000-8000-000000000010';

let tenantId = '';
let companyId = '';

async function cleanDb() {
  await db.delete(reportLetters).where(like(reportLetters.name, `${NAME_PREFIX}%`));
  if (tenantId) {
    await db.delete(reportPackItems).where(
      inArray(reportPackItems.packId, db.select({ id: reportPacks.id }).from(reportPacks).where(eq(reportPacks.tenantId, tenantId))),
    );
    await db.delete(reportPacks).where(eq(reportPacks.tenantId, tenantId));
    await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
    await db.delete(companies).where(eq(companies.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    tenantId = '';
  }
}

beforeEach(async () => {
  await cleanDb();
  const [tenant] = await db.insert(tenants).values({
    name: 'Letter Test', slug: `letter-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    reportSettings: { firmName: 'Doe & Associates, CPA', firmCity: 'Austin', firmState: 'TX' },
  }).returning();
  tenantId = tenant!.id;
  const [company] = await db.insert(companies).values({
    tenantId, businessName: 'Acme Widgets LLC', city: 'Dallas', state: 'TX',
  }).returning();
  companyId = company!.id;
});

afterEach(async () => {
  await cleanDb();
});

describe('resolveLetterVariables', () => {
  it('resolves firm identity from report settings, client from company, GAAP wording for accrual', async () => {
    const vars = await letterService.resolveLetterVariables(tenantId, companyId, {
      periodStart: '2025-01-01', periodEnd: '2025-12-31', basis: 'accrual', letterType: 'compilation',
    });
    expect(vars['client_name']).toBe('Acme Widgets LLC');
    expect(vars['firm_name']).toBe('Doe & Associates, CPA');
    expect(vars['firm_city_state']).toBe('Austin, TX');
    expect(vars['period_description']).toBe('year ended December 31, 2025');
    expect(vars['as_of_date']).toBe('December 31, 2025');
    expect(vars['basis_of_accounting']).toContain('generally accepted');
    expect(vars['financial_statement_titles']).toContain('balance sheet');
    expect(vars['report_title']).toBe("Accountant's Compilation Report");
  });

  it('is basis-aware (cash basis uses cash framework + titles)', async () => {
    const vars = await letterService.resolveLetterVariables(tenantId, companyId, {
      periodStart: '2025-01-01', periodEnd: '2025-12-31', basis: 'cash',
    });
    expect(vars['basis_of_accounting']).toBe('the cash basis of accounting');
    expect(vars['financial_statement_titles']).toContain('cash transactions');
  });

  it('falls back to company name/city/state when no firm identity is set', async () => {
    await db.update(tenants).set({ reportSettings: {} }).where(eq(tenants.id, tenantId));
    const vars = await letterService.resolveLetterVariables(tenantId, companyId, {
      periodStart: '2025-01-01', periodEnd: '2025-12-31', basis: 'accrual',
    });
    expect(vars['firm_name']).toBe('Acme Widgets LLC');
    expect(vars['firm_city_state']).toBe('Dallas, TX');
  });
});

describe('resolveLetterContent + buildLetterPageHtml', () => {
  it('substitutes variables into a compilation letter body', async () => {
    const [letter] = await db.insert(reportLetters).values({
      name: `${NAME_PREFIX}compilation`,
      letterType: 'compilation',
      bodyHtml: '<p>Management is responsible for the accompanying financial statements of {{client_name}}, which comprise the {{financial_statement_titles}} as of {{as_of_date}} and for the {{period_description}} in accordance with {{basis_of_accounting}}.</p><p>{{firm_name}}<br>{{firm_city_state}}<br>{{letter_date}}</p>',
    }).returning();

    const { title, bodyHtml } = await letterService.resolveLetterContent(letter!, tenantId, companyId, {
      periodStart: '2025-01-01', periodEnd: '2025-12-31', basis: 'accrual', reportDate: '2026-02-15',
    });

    expect(title).toBe("Accountant's Compilation Report");
    expect(bodyHtml).toContain('Acme Widgets LLC');
    expect(bodyHtml).toContain('year ended December 31, 2025');
    expect(bodyHtml).toContain('generally accepted in the United States of America');
    expect(bodyHtml).toContain('Doe &amp; Associates, CPA'); // value HTML-escaped
    expect(bodyHtml).toContain('February 15, 2026');
    expect(bodyHtml).not.toContain('{{');

    const page = letterService.buildLetterPageHtml({ title, bodyHtml, companyName: 'Acme Widgets LLC' });
    expect(page).toContain("Accountant's Compilation Report");
    expect(page).toContain('year ended December 31, 2025');
  });

  it('uses the letter\'s title override and font when set', async () => {
    const [letter] = await db.insert(reportLetters).values({
      name: `${NAME_PREFIX}custom`,
      letterType: 'compilation',
      title: 'Independent Accountant’s Report',
      fontFamily: 'times',
      bodyHtml: '<p>Body for {{client_name}}.</p>',
    }).returning();

    const { title, fontStack } = await letterService.resolveLetterContent(letter!, tenantId, companyId, {
      periodStart: '2025-01-01', periodEnd: '2025-12-31', basis: 'accrual',
    });
    expect(title).toBe('Independent Accountant’s Report');
    expect(title).not.toBe("Accountant's Compilation Report");
    expect(fontStack).toContain('Times New Roman');

    const page = letterService.buildLetterPageHtml({ title, bodyHtml: '<p>x</p>', companyName: 'Acme', fontStack });
    expect(page).toContain('Independent Accountant’s Report');
    expect(page).toContain('Times New Roman');
  });

  it('omits the heading when the title is blank', () => {
    const page = letterService.buildLetterPageHtml({ title: '', bodyHtml: '<p>x</p>', companyName: 'Acme' });
    expect(page).not.toContain('<h1>');
  });
});

describe('report pack letter selection', () => {
  it('persists letterId through create + get', async () => {
    const [letter] = await db.insert(reportLetters).values({
      name: `${NAME_PREFIX}prep`, letterType: 'preparation', bodyHtml: '<p>No assurance is provided.</p>',
    }).returning();

    const pack = await packService.createPack(tenantId, companyId, USER_ID, {
      name: 'With Letter',
      letterId: letter!.id,
      items: [{ reportId: 'profit-loss' }],
    });
    expect(pack.letterId).toBe(letter!.id);

    const fetched = await packService.getPack(tenantId, pack.id);
    expect(fetched.letterId).toBe(letter!.id);
  });
});

describe('CRUD writes an audit log', () => {
  it('audits letter creation', async () => {
    const letter = await letterService.createLetter(
      { name: `${NAME_PREFIX}audit`, letterType: 'preparation', bodyHtml: '<p>x</p>' },
      tenantId, USER_ID,
    );
    const rows = await db.select().from(auditLog)
      .where(eq(auditLog.entityId, letter.id));
    expect(rows.some((r) => r.action === 'create' && r.entityType === 'report_letter')).toBe(true);
  });
});
