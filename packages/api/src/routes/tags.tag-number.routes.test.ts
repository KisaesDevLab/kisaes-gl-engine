// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Tag numbers (ClientLedger U-75, tag-number-v1): optional, trimmed, up to
// 20 characters, unique per tenant when set (409 TAG_NUMBER_EXISTS on create
// and update), '' or null clears, omitted keeps; returned by every tag route;
// the list sorts by number (tags without one last) then name, and search
// matches the number. The archive round trip is in
// services/tenant-portability/roundtrip.test.ts.

import 'express-async-errors';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { tagsRouter } from './tags.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { makeCompany, cleanTenant, type Co } from '../services/templates/templates.test-helpers.js';

interface Res { status: number; json: ReturnType<typeof JSON.parse> }

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
let a: Co;
let b: Co;

function request(method: string, pathname: string, token: string, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(data ? { 'Content-Length': String(data.length) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }); }
        catch { resolve({ status: res.statusCode ?? 0, json: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const create = (c: Co, body: Record<string, unknown>) => request('POST', '/api/v1/tags', c.token, body);
const update = (c: Co, id: string, body: Record<string, unknown>) => request('PUT', `/api/v1/tags/${id}`, c.token, body);

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/tags', tagsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
  a = await makeCompany('tagnum-a', tenantIds);
  b = await makeCompany('tagnum-b', tenantIds);
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

describe('tag numbers (tag-number-v1)', () => {
  it('is advertised as a desktop capability', () => {
    expect(DESKTOP_CAPABILITIES).toContain('tag-number-v1');
  });

  it('creates with a trimmed number and returns it from every tag route', async () => {
    const r = await create(a, { name: 'Kitchen jobs', tagNumber: '  100  ' });
    expect(r.status).toBe(201);
    expect(r.json.tag.tagNumber).toBe('100');
    const id = r.json.tag.id as string;

    expect((await request('GET', `/api/v1/tags/${id}`, a.token)).json.tag.tagNumber).toBe('100');
    const list = await request('GET', '/api/v1/tags', a.token);
    expect(list.json.tags.find((t: { id: string }) => t.id === id).tagNumber).toBe('100');
    const usage = await request('GET', `/api/v1/tags/${id}/usage`, a.token);
    expect(usage.json.tag.tagNumber).toBe('100');
    const summary = await request('GET', '/api/v1/tags/usage-summary', a.token);
    expect(summary.json.tags.find((t: { id: string }) => t.id === id).tagNumber).toBe('100');
  });

  it('creates without a number (null), and an empty string is no number', async () => {
    const none = await create(a, { name: 'No number' });
    expect(none.status).toBe(201);
    expect(none.json.tag.tagNumber).toBeNull();
    const blank = await create(a, { name: 'Blank number', tagNumber: '   ' });
    expect(blank.status).toBe(201);
    expect(blank.json.tag.tagNumber).toBeNull();
  });

  it('refuses more than 20 characters', async () => {
    const r = await create(a, { name: 'Too long', tagNumber: 'x'.repeat(21) });
    expect(r.status).toBe(400);
    const ok = await create(a, { name: 'Twenty', tagNumber: 'y'.repeat(20) });
    expect(ok.status).toBe(201);
  });

  it('a duplicate number is 409 TAG_NUMBER_EXISTS on create and update; other tenants are independent', async () => {
    const first = await create(a, { name: 'Dup one', tagNumber: '200' });
    expect(first.status).toBe(201);
    const dup = await create(a, { name: 'Dup two', tagNumber: '200' });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe('TAG_NUMBER_EXISTS');

    const second = await create(a, { name: 'Dup three', tagNumber: '201' });
    const clash = await update(a, second.json.tag.id, { tagNumber: ' 200 ' });
    expect(clash.status).toBe(409);
    expect(clash.json.error.code).toBe('TAG_NUMBER_EXISTS');
    // Saving a tag with its own number is not a clash.
    const same = await update(a, first.json.tag.id, { tagNumber: '200', name: 'Dup one renamed' });
    expect(same.status).toBe(200);
    expect(same.json.tag.tagNumber).toBe('200');

    const other = await create(b, { name: 'Other tenant', tagNumber: '200' });
    expect(other.status).toBe(201);
  });

  it('update: omitted keeps, a new value replaces, empty string and null clear', async () => {
    const t = (await create(a, { name: 'Changing', tagNumber: '300' })).json.tag;
    const kept = await update(a, t.id, { description: 'note' });
    expect(kept.json.tag.tagNumber).toBe('300');
    const replaced = await update(a, t.id, { tagNumber: '301' });
    expect(replaced.json.tag.tagNumber).toBe('301');
    // The old number is free again.
    expect((await create(a, { name: 'Reuses 300', tagNumber: '300' })).status).toBe(201);
    const cleared = await update(a, t.id, { tagNumber: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.json.tag.tagNumber).toBeNull();
    await update(a, t.id, { tagNumber: '302' });
    const nulled = await update(a, t.id, { tagNumber: null });
    expect(nulled.json.tag.tagNumber).toBeNull();
    // Two tags without a number never collide.
    expect((await create(a, { name: 'Another none' })).status).toBe(201);
  });

  it('lists by number (text order), tags without a number last, then name; search matches the number', async () => {
    const c = await makeCompany('tagnum-sort', tenantIds);
    // makeCompany seeds one tag without a number ("Crew tagnum-sort").
    for (const [name, tagNumber] of [['Zulu', '20'], ['Alpha', '30'], ['Mike', null], ['Bravo', '10'], ['Echo', null]] as const) {
      expect((await create(c, { name, tagNumber })).status).toBe(201);
    }
    const list = await request('GET', '/api/v1/tags', c.token);
    expect(list.json.tags.map((t: { name: string }) => t.name)).toEqual(['Bravo', 'Zulu', 'Alpha', 'Crew tagnum-sort', 'Echo', 'Mike']);

    const byNumber = await request('GET', '/api/v1/tags?search=3', c.token);
    expect(byNumber.json.tags.map((t: { name: string }) => t.name)).toEqual(['Alpha']);
    const byName = await request('GET', '/api/v1/tags?search=ech', c.token);
    expect(byName.json.tags.map((t: { name: string }) => t.name)).toEqual(['Echo']);
  });
});
