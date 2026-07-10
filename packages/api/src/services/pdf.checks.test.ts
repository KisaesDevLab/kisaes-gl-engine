// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Guards the check print layouts rendered by pdf.service. Focus is the
// z_fold (Z-Fold pressure-seal) layout: the check coupon must sit in the
// middle panel (4.0625in), both fold guides must be present, and on blank
// stock the MICR line must render — while the standard layouts must NOT
// emit the z_fold-specific fold guides.

import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, companies } from '../db/schema/index.js';
import { getTestCheckHtml } from './pdf.service.js';

let tenantId = '';

async function seedCompany(checkSettings: Record<string, unknown>) {
  const [t] = await db.insert(tenants).values({ name: 'PDF', slug: 'pdf-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) }).returning();
  tenantId = t!.id;
  await db.insert(companies).values({
    tenantId, businessName: 'Test Co', entityType: 'sole_prop', setupComplete: true,
    checkSettings,
  });
  return tenantId;
}

afterEach(async () => {
  if (tenantId) {
    await db.delete(companies).where(eq(companies.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    tenantId = '';
  }
});

describe('renderCheckHtml — z_fold layout', () => {
  it('places the coupon in the middle panel with both fold guides and a MICR line (blank stock)', async () => {
    const id = await seedCompany({
      format: 'z_fold', printOnBlankStock: true,
      routingNumber: '081000032', accountNumber: '1234567890',
    });
    const html = await getTestCheckHtml(id, 'z_fold');
    expect(html).toContain('top:4.0625in');   // middle coupon
    expect(html).toContain('top:3.667in');     // upper fold guide
    expect(html).toContain('top:7.333in');     // lower fold guide
    expect(html).toContain('PAY TO THE ORDER OF');
    expect(html).toContain('081000032');       // MICR routing prints on blank stock
    expect(html).toContain('AUTHORIZED SIGNATURE');
  });

  it('omits the MICR line on pre-printed stock', async () => {
    const id = await seedCompany({ format: 'z_fold', printOnBlankStock: false, routingNumber: '081000032' });
    const html = await getTestCheckHtml(id, 'z_fold');
    expect(html).not.toContain('081000032');
  });

  it('standard layouts do not emit the z_fold fold guides', async () => {
    const id = await seedCompany({ format: 'voucher' });
    const html = await getTestCheckHtml(id, 'voucher');
    expect(html).not.toContain('top:4.0625in');
    expect(html).not.toContain('top:7.333in');
  });
});
