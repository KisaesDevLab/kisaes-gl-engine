// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants,
  firms,
  tenantFirmAssignments,
  firmTagTemplates,
  tenantFirmTagBindings,
  tags,
  tagGroups,
} from '../db/schema/index.js';
import * as service from './firm-tag-templates.service.js';

// 3-tier rules plan, Phase 7 — service-level coverage. CRUD on
// firm_tag_templates + binding upsert path with tenant + tag
// validity guards.

let firmId = '';
let tenantId = '';
let tagGroupId = '';
let tagId = '';

async function cleanup() {
  if (firmId) {
    await db.delete(tenantFirmTagBindings).where(eq(tenantFirmTagBindings.firmId, firmId));
    await db.delete(firmTagTemplates).where(eq(firmTagTemplates.firmId, firmId));
    await db.delete(tenantFirmAssignments).where(eq(tenantFirmAssignments.firmId, firmId));
  }
  if (tagId) {
    await db.delete(tags).where(eq(tags.id, tagId));
  }
  if (tagGroupId) {
    await db.delete(tagGroups).where(eq(tagGroups.id, tagGroupId));
  }
  if (tenantId) {
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  }
  if (firmId) {
    await db.delete(firms).where(eq(firms.id, firmId));
  }
  firmId = '';
  tenantId = '';
  tagGroupId = '';
  tagId = '';
}

beforeEach(async () => {
  await cleanup();
  const [firm] = await db.insert(firms).values({
    name: 'TT Firm',
    slug: `tt-firm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  }).returning();
  firmId = firm!.id;
  const [t] = await db.insert(tenants).values({
    name: 'TT Tenant',
    slug: `tt-tenant-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  }).returning();
  tenantId = t!.id;
  await db.insert(tenantFirmAssignments).values({ tenantId, firmId });

  const [g] = await db.insert(tagGroups).values({
    tenantId,
    name: 'Billing',
  }).returning();
  tagGroupId = g!.id;
  const [tag] = await db.insert(tags).values({
    tenantId,
    groupId: tagGroupId,
    name: 'Billable',
    isActive: true,
  }).returning();
  tagId = tag!.id;
});

afterEach(async () => {
  await cleanup();
});

describe('firm-tag-templates — CRUD', () => {
  it('create + getById + list', async () => {
    const tpl = await service.createTemplate(firmId, {
      templateKey: 'billable',
      displayName: 'Billable',
      description: 'Time / expense billed back to client',
    });
    expect(tpl.templateKey).toBe('billable');
    expect(tpl.firmId).toBe(firmId);

    const fetched = await service.getTemplate(firmId, tpl.id);
    expect(fetched.id).toBe(tpl.id);

    const list = await service.listTemplates(firmId);
    expect(list).toHaveLength(1);
  });

  it('rejects duplicate template_key', async () => {
    await service.createTemplate(firmId, {
      templateKey: 'billable',
      displayName: 'Billable',
    });
    await expect(
      service.createTemplate(firmId, {
        templateKey: 'billable',
        displayName: 'Other',
      }),
    ).rejects.toThrow(/already exists/);
  });

  it('updateTemplate updates display + description but not key', async () => {
    const tpl = await service.createTemplate(firmId, {
      templateKey: 'reimburse',
      displayName: 'Reimbursable',
    });
    const updated = await service.updateTemplate(firmId, tpl.id, {
      displayName: 'Client reimbursable',
      description: 'New description',
    });
    expect(updated.displayName).toBe('Client reimbursable');
    expect(updated.description).toBe('New description');
    // template_key unchanged.
    expect(updated.templateKey).toBe('reimburse');
  });

  it('deleteTemplate cascades to bindings on the same template_key', async () => {
    const tpl = await service.createTemplate(firmId, {
      templateKey: 'billable',
      displayName: 'Billable',
    });
    await service.upsertBinding(firmId, tpl.id, { tenantId, tagId });
    await service.deleteTemplate(firmId, tpl.id);
    const bindings = await db
      .select()
      .from(tenantFirmTagBindings)
      .where(eq(tenantFirmTagBindings.firmId, firmId));
    expect(bindings).toHaveLength(0);
  });
});

describe('firm-tag-templates — bindings', () => {
  it('upsert creates a new binding when missing', async () => {
    const tpl = await service.createTemplate(firmId, {
      templateKey: 'billable',
      displayName: 'Billable',
    });
    const binding = await service.upsertBinding(firmId, tpl.id, { tenantId, tagId });
    expect(binding.firmId).toBe(firmId);
    expect(binding.tenantId).toBe(tenantId);
    expect(binding.tagId).toBe(tagId);
    expect(binding.templateKey).toBe('billable');
  });

  it('upsert is idempotent on the (firm, tenant, key) triple', async () => {
    const tpl = await service.createTemplate(firmId, {
      templateKey: 'billable',
      displayName: 'Billable',
    });
    const first = await service.upsertBinding(firmId, tpl.id, { tenantId, tagId });
    const second = await service.upsertBinding(firmId, tpl.id, { tenantId, tagId });
    expect(second.id).toBe(first.id);
  });

  it('upsert rejects unmanaged tenant', async () => {
    const tpl = await service.createTemplate(firmId, {
      templateKey: 'billable',
      displayName: 'Billable',
    });
    const [orphan] = await db.insert(tenants).values({
      name: 'Orphan',
      slug: `orphan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    }).returning();
    try {
      await expect(
        service.upsertBinding(firmId, tpl.id, { tenantId: orphan!.id, tagId }),
      ).rejects.toThrow(/not managed/);
    } finally {
      await db.delete(tenants).where(eq(tenants.id, orphan!.id));
    }
  });

  it('upsert rejects tag from a different tenant', async () => {
    const tpl = await service.createTemplate(firmId, {
      templateKey: 'billable',
      displayName: 'Billable',
    });
    // Create a tag on a *different* tenant + assign that tenant
    // to the same firm so the tenant check passes; the tag check
    // should still reject.
    const [other] = await db.insert(tenants).values({
      name: 'Other',
      slug: `other-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    }).returning();
    await db.insert(tenantFirmAssignments).values({ tenantId: other!.id, firmId });
    const [otherGroup] = await db.insert(tagGroups).values({
      tenantId: other!.id,
      name: 'G',
    }).returning();
    const [otherTag] = await db.insert(tags).values({
      tenantId: other!.id,
      groupId: otherGroup!.id,
      name: 'Foreign',
      isActive: true,
    }).returning();
    try {
      await expect(
        service.upsertBinding(firmId, tpl.id, { tenantId, tagId: otherTag!.id }),
      ).rejects.toThrow(/not found in the target tenant/i);
    } finally {
      await db.delete(tags).where(eq(tags.id, otherTag!.id));
      await db.delete(tagGroups).where(eq(tagGroups.id, otherGroup!.id));
      await db.delete(tenantFirmAssignments).where(eq(tenantFirmAssignments.tenantId, other!.id));
      await db.delete(tenants).where(eq(tenants.id, other!.id));
    }
  });

  it('resolveTagFromTemplate finds the bound tag id', async () => {
    const tpl = await service.createTemplate(firmId, {
      templateKey: 'billable',
      displayName: 'Billable',
    });
    await service.upsertBinding(firmId, tpl.id, { tenantId, tagId });
    const resolved = await service.resolveTagFromTemplate(firmId, 'billable', tenantId);
    expect(resolved).toBe(tagId);
  });

  it('resolveTagFromTemplate returns null when no binding exists', async () => {
    await service.createTemplate(firmId, {
      templateKey: 'billable',
      displayName: 'Billable',
    });
    const resolved = await service.resolveTagFromTemplate(firmId, 'billable', tenantId);
    expect(resolved).toBeNull();
  });
});
