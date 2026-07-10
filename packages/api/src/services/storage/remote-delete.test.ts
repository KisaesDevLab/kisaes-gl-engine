// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { OneDriveProvider } from './onedrive.provider.js';
import { GoogleDriveProvider } from './google-drive.provider.js';

// Regression: both providers' delete() used to `await fetch(...)` and discard
// the response, so a 401/403/404/5xx silently "succeeded". The remote-backup
// purge then dropped the manifest entry for a file that still existed —
// a silent orphan / retention-policy violation. delete() must surface non-2xx
// (except 404, which is an idempotent already-gone) so the caller keeps the
// manifest entry.

describe('OneDriveProvider.delete — surfaces HTTP failures', () => {
  afterEach(() => vi.restoreAllMocks());

  it('resolves on 204 (deleted) and 404 (already gone, idempotent)', async () => {
    for (const status of [204, 404]) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status }));
      await expect(new OneDriveProvider('token').delete('item-id')).resolves.toBeUndefined();
      vi.restoreAllMocks();
    }
  });

  it('throws on 401/403/500 instead of silently succeeding', async () => {
    for (const status of [401, 403, 500]) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status }));
      await expect(new OneDriveProvider('token').delete('item-id')).rejects.toThrow(
        new RegExp(`OneDrive delete failed: ${status}`),
      );
      vi.restoreAllMocks();
    }
  });
});

describe('GoogleDriveProvider.delete — surfaces HTTP failures', () => {
  afterEach(() => vi.restoreAllMocks());

  it('resolves on 204 (deleted) and 404 (already gone, idempotent)', async () => {
    for (const status of [204, 404]) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status }));
      await expect(new GoogleDriveProvider('token').delete('file-id')).resolves.toBeUndefined();
      vi.restoreAllMocks();
    }
  });

  it('throws on 401/403/500 instead of silently succeeding', async () => {
    for (const status of [401, 403, 500]) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status }));
      await expect(new GoogleDriveProvider('token').delete('file-id')).rejects.toThrow(
        new RegExp(`Google Drive delete failed: ${status}`),
      );
      vi.restoreAllMocks();
    }
  });
});
