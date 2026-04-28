// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { escapeHtml, w9HtmlTemplate } from './portal-pdf.service.js';

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
    expect(escapeHtml("a & b's")).toBe('a &amp; b&#39;s');
  });

  it('coerces nullish to empty string', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('w9HtmlTemplate', () => {
  const baseInput = {
    legalName: 'Jane Smith',
    businessName: 'Smith LLC',
    taxClassification: 'Individual / sole proprietor',
    exemptPayeeCode: undefined,
    address: { line1: '123 Main St', city: 'Austin', state: 'TX', zip: '78701' },
    tinMasked: '***-**-1234',
    tinType: 'SSN' as const,
    signedAt: new Date('2026-04-26T15:00:00Z'),
    signatureName: 'Jane Smith',
    ipAddress: '203.0.113.7',
  };

  it('never embeds the unmasked TIN', () => {
    const html = w9HtmlTemplate(baseInput);
    // TIN must only appear masked, even though the form collects it.
    expect(html).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
    expect(html).toContain('***-**-1234');
  });

  it('embeds the captured signature, signer name, and IP', () => {
    const html = w9HtmlTemplate(baseInput);
    expect(html).toContain('Jane Smith');
    expect(html).toContain('203.0.113.7');
    expect(html).toContain('Electronic signature');
  });

  it('escapes HTML in user-supplied fields', () => {
    const html = w9HtmlTemplate({
      ...baseInput,
      legalName: '<script>alert(1)</script>',
      businessName: '"O\'Brien" & Co',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;O&#39;Brien&quot; &amp; Co');
  });

  it('omits the IP block when no ip is provided', () => {
    const html = w9HtmlTemplate({ ...baseInput, ipAddress: null });
    expect(html).not.toContain('From IP');
  });
});
