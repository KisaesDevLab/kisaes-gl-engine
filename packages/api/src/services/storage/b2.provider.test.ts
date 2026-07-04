// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { B2Provider, buildB2S3Config, deriveB2Region } from './b2.provider.js';

describe('deriveB2Region', () => {
  it('parses the region from a standard B2 S3 endpoint', () => {
    expect(deriveB2Region('https://s3.us-west-004.backblazeb2.com')).toBe('us-west-004');
    expect(deriveB2Region('https://s3.eu-central-003.backblazeb2.com')).toBe('eu-central-003');
  });

  it('returns undefined for non-B2 endpoints', () => {
    expect(deriveB2Region('https://s3.example.com')).toBeUndefined();
    expect(deriveB2Region('https://minio.internal:9000')).toBeUndefined();
  });
});

describe('buildB2S3Config', () => {
  it('maps B2 vocabulary onto the S3 constructor shape', () => {
    const cfg = buildB2S3Config({
      bucket: 'my-bucket',
      endpoint: 'https://s3.us-west-004.backblazeb2.com',
      keyId: 'key-id-123',
      applicationKey: 'app-key-secret',
      prefix: 'files/',
    });
    expect(cfg).toEqual({
      bucket: 'my-bucket',
      region: 'us-west-004', // derived from endpoint
      endpoint: 'https://s3.us-west-004.backblazeb2.com',
      accessKeyId: 'key-id-123',
      secretAccessKey: 'app-key-secret',
      prefix: 'files/',
    });
  });

  it('prefers an explicit region over the derived one', () => {
    const cfg = buildB2S3Config({
      bucket: 'b',
      endpoint: 'https://s3.us-west-004.backblazeb2.com',
      keyId: 'k',
      applicationKey: 'a',
      region: 'custom-region',
    });
    expect(cfg.region).toBe('custom-region');
  });

  it('falls back to a placeholder region for unparseable endpoints', () => {
    const cfg = buildB2S3Config({
      bucket: 'b',
      endpoint: 'https://minio.internal:9000',
      keyId: 'k',
      applicationKey: 'a',
    });
    expect(cfg.region).toBe('us-east-1');
  });
});

describe('B2Provider', () => {
  it('reports name "b2" (attachments stamp storage_provider from this)', () => {
    const provider = new B2Provider({
      bucket: 'b',
      endpoint: 'https://s3.us-west-004.backblazeb2.com',
      keyId: 'k',
      applicationKey: 'a',
    });
    expect(provider.name).toBe('b2');
    expect(provider.requiresOAuth).toBe(false);
  });
});
