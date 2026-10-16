// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tesseract language data: never downloaded from the CDN in desktop mode.
// tesseract.js is mocked; the test checks the options createWorker gets.

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const createWorker = vi.hoisted(() => vi.fn(async () => ({
  recognize: async () => ({ data: { text: 'hello', confidence: 90 } }),
  terminate: async () => undefined,
})));
vi.mock('tesseract.js', () => ({ createWorker }));

import { loadDesktopProfile, _resetDesktopProfileForTests } from '../desktop/profile.js';
import { shutdownTesseract, tesseractOcr, tesseractWorkerOptions } from './local-ocr.service.js';

function desktop(dataDir: string) {
  loadDesktopProfile({ CL_MODE: 'desktop', CL_TOKEN: 't'.repeat(48), CL_BIND: '127.0.0.1:0', CL_DATA_DIR: dataDir });
}

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-tessdata-'));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  await shutdownTesseract();
  createWorker.mockClear();
  vi.unstubAllEnvs();
  _resetDesktopProfileForTests();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('server appliance', () => {
  it('without OCR_LANG_PATH: createWorker("eng") exactly as before', async () => {
    loadDesktopProfile({});
    vi.stubEnv('OCR_LANG_PATH', '');
    expect(tesseractWorkerOptions()).toBeNull();
    await tesseractOcr(Buffer.from('x'));
    expect(createWorker).toHaveBeenCalledWith('eng');
  });

  it('OCR_LANG_PATH points the worker at local data', async () => {
    loadDesktopProfile({});
    const d = tmp();
    fs.writeFileSync(path.join(d, 'eng.traineddata.gz'), 'x');
    vi.stubEnv('OCR_LANG_PATH', d);
    expect(tesseractWorkerOptions()).toMatchObject({ langPath: path.resolve(d), gzip: true });
  });
});

describe('desktop mode', () => {
  it('uses <CL_DATA_DIR>/tessdata and caches under <CL_DATA_DIR>/cache/tesseract', async () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'tessdata'));
    fs.writeFileSync(path.join(d, 'tessdata', 'eng.traineddata'), 'x');
    desktop(d);
    const r = await tesseractOcr(Buffer.from('x'));
    expect(r.text).toBe('hello');
    expect(createWorker).toHaveBeenCalledWith('eng', undefined, {
      langPath: path.join(d, 'tessdata'),
      cachePath: path.join(d, 'cache', 'tesseract'),
      gzip: false,
    });
  });

  it('missing language data: OCR_DATA_MISSING, no worker started (so nothing is downloaded)', async () => {
    const d = tmp();
    desktop(d);
    await expect(tesseractOcr(Buffer.from('x'))).rejects.toMatchObject({ code: 'OCR_DATA_MISSING', statusCode: 503 });
    expect(createWorker).not.toHaveBeenCalled();
    // Installing the data later works without a restart.
    fs.mkdirSync(path.join(d, 'tessdata'));
    fs.writeFileSync(path.join(d, 'tessdata', 'eng.traineddata'), 'x');
    await tesseractOcr(Buffer.from('x'));
    expect(createWorker).toHaveBeenCalledTimes(1);
  });

  it('OCR_WORKER_PATH is passed through for single-executable builds', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'tessdata'));
    fs.writeFileSync(path.join(d, 'tessdata', 'eng.traineddata'), 'x');
    desktop(d);
    vi.stubEnv('OCR_WORKER_PATH', path.join(d, 'worker.js'));
    expect(tesseractWorkerOptions()?.workerPath).toBe(path.join(d, 'worker.js'));
  });
});
