// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// U-93 (intake-settings-v1): folder validation table.

import { describe, it, expect } from 'vitest';
import {
  INTAKE_SETTINGS_DEFAULT_JSON, intakeFolderSchema, intakeFoldersSchema, intakeNameKey, intakePathKey, intakePathProblem,
  putIntakeSettingsSchema,
} from './intake-settings.js';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const folder = (over: Record<string, unknown> = {}) => ({
  id: ID(1), name: 'Bills', path: 'C:\\Scans\\Bills', defaultKind: 'bills', autoRead: false, keepOriginals: false, ...over,
});

describe('intake folder paths', () => {
  const accepted = [
    'C:\\Scans\\Bills',
    'c:/Users/owner/Documents/Receipts',
    'D:\\',
    '\\\\nas\\scans\\bills',
    '\\\\nas.local\\share',
    '\\\\192.168.1.20\\scans',
    '/Users/owner/Dropbox/Receipts',
    '/home/owner/Scans',
    '/mnt/nas/scans',
    'C:\\Scans\\Bills (2026)\\März',
    'C:\\Scans\\..hidden\\x',
    'C:\\Scans\\a.b\\c',
    '/srv/scans@home',
    '\\\\[fe80::1]\\scans',
    '\\\\nas-01_b.example.com\\scans',
    '/tmp/a:b',
    'C:\\Scans\\CONSOLE',
    'C:\\Scans\\COM10',
    'C:\\Scans\\nul-files',
    'C:\\Scans\\.hidden',
    'C:\\Scans\\Bills\\',
    'C:\\Scans\\Caf\u00e9 \u4e2d\u6587 \ud83d\udcc4',
    'C:\\' + 'a'.repeat(1021),
  ];
  for (const p of accepted) {
    it(`accepts ${JSON.stringify(p.length > 60 ? p.slice(0, 20) + '…' : p)}`, () => {
      expect(intakePathProblem(p)).toBeNull();
    });
  }

  const refused: Array<[string, string]> = [
    ['', 'empty'],
    ['C:\\' + 'a'.repeat(1022), 'too long (1025)'],
    ['Scans\\Bills', 'relative'],
    ['C:Scans', 'drive-relative'],
    ['\\Scans', 'rooted without drive'],
    ['~/Scans', 'home shorthand'],
    ['\\\\?\\C:\\Scans', 'Win32 long-path prefix'],
    ['\\\\.\\PhysicalDrive0', 'device namespace'],
    ['//?/C:/Scans', 'long-path prefix with slashes'],
    ['//./COM1', 'device namespace with slashes'],
    ['\\??\\C:\\Scans', 'NT namespace'],
    ['/??/C:/Scans', 'NT namespace with slashes'],
    ['//nas/scans', 'double-slash path'],
    ['file:///C:/Scans', 'file URL'],
    ['https://example.com/dav', 'web URL'],
    ['C:\\Scans\\smb://x', 'URL inside'],
    ['\\\\server@SSL\\DavWWWRoot\\scans', 'WebDAV over SSL'],
    ['\\\\server@SSL@443\\scans', 'WebDAV SSL and port'],
    ['\\\\server@8080\\scans', 'WebDAV port'],
    ['\\\\server\\DavWWWRoot\\scans', 'DavWWWRoot'],
    ['\\\\server\\davwwwroot', 'davwwwroot lower case'],
    ['C:\\Scans\\..\\Windows', '.. segment'],
    ['/home/owner/../root', '.. segment unix'],
    ['C:/Scans/..', 'trailing .. segment'],
    ['\\\\nas\\..\\x', '.. after host'],
    ['C:\\Scans\u0000', 'NUL'],
    ['C:\\Scans\nBills', 'newline'],
    ['C:\\Scans\u007f', 'DEL'],
    ['C:\\Scans\u0085', 'C1 control'],
    ['\\\\', 'bare double backslash'],
    ['\\\\\\server', 'three backslashes'],
    // Reserved device names, in any segment, any case, with an extension or trailing dots and spaces.
    ['C:\\Scans\\CON', 'CON'],
    ['C:\\Scans\\nul\\x', 'nul mid-path'],
    ['C:\\Scans\\NUL.txt', 'NUL with an extension'],
    ['C:\\Scans\\aux.tar.gz', 'AUX with two extensions'],
    ['C:\\prn .', 'PRN with a trailing space and dot'],
    ['C:\\Scans\\COM1', 'COM1'],
    ['C:\\Scans\\com0', 'COM0'],
    ['C:\\Scans\\LPT9.log', 'LPT9 with an extension'],
    ['C:\\Scans\\COM\u00b9', 'COM superscript 1'],
    ['C:\\Scans\\lpt\u00b3', 'LPT superscript 3'],
    ['C:\\Scans\\CONIN$', 'CONIN$'],
    ['C:\\Scans\\conout$.x', 'CONOUT$ with an extension'],
    ['\\\\nas\\scans\\CON', 'CON on a share'],
    ['/mnt/scans/aux', 'aux in a Unix path'],
    // Invisible and direction-changing characters.
    ['C:\\Scans\\\u202eslib', 'right-to-left override'],
    ['C:\\Scans\\a\u2066b\u2069', 'bidi isolate'],
    ['C:\\Scans\\a\u200bb', 'zero-width space'],
    ['C:\\Scans\\a\u200db', 'zero-width joiner'],
    ['C:\\Scans\\\ufeffBills', 'byte order mark'],
    ['C:\\Scans\\a\u00adb', 'soft hyphen'],
    ['C:\\Scans\\a\u2028b', 'line separator'],
    ['C:\\Scans\\a\u2029b', 'paragraph separator'],
    ['C:\\Scans\\a\ud800b', 'lone high surrogate'],
    ['C:\\Scans\\a\udc00', 'lone low surrogate'],
    // Alternate data streams.
    ['C:\\Scans:stream', 'stream on a drive path'],
    ['C:\\Scans\\Bills:$DATA', 'stream type on a drive path'],
    ['C:/Scans/x:y', 'colon on a drive path with slashes'],
    ['\\\\nas\\scans:stream', 'stream on a share'],
    ['\\\\nas\\scans\\x:y', 'colon deeper on a share'],
    // UNC hosts.
    ['\\\\user:pw@nas\\scans', 'user and password in the host'],
    ['\\\\user@nas\\scans', 'user in the host'],
    ['\\\\nas:445\\scans', 'port in the host'],
    ['\\\\[fe80::1\\scans', 'unclosed IPv6 bracket'],
    ['\\\\[nas]\\scans', 'bracketed name'],
    ['\\\\n\u00e4s\\scans', 'non-ASCII host'],
    ['\\\\nas%20x\\scans', 'escaped host'],
    // Segments ending in a dot or a space.
    ['C:\\Scans\\Bills.', 'trailing dot'],
    ['C:\\Scans\\Bills \\x', 'trailing space mid-path'],
    ['C:\\Scans\\.', 'dot segment'],
    ['C:\\Scans\\...', 'dots segment'],
    ['/home/owner/Scans ', 'trailing space unix'],
    ['\\\\nas\\scans.', 'share ending in a dot'],
  ];
  for (const [p, why] of refused) {
    it(`refuses ${why}`, () => {
      expect(intakePathProblem(p)).not.toBeNull();
      // The problem text never repeats the path.
      if (p.length > 3) expect(intakePathProblem(p)).not.toContain(p);
    });
  }

  it('compares paths ignoring case, separators and trailing separators', () => {
    expect(intakePathKey('C:\\Scans\\Bills')).toBe(intakePathKey('c:/scans/bills/'));
    expect(intakePathKey('\\\\NAS\\Scans')).toBe(intakePathKey('\\\\nas\\scans\\'));
    expect(intakePathKey('/')).toBe('\\');
  });

  it('compares paths and names after Unicode NFC normalization', () => {
    expect(intakePathKey('C:\\Scans\\Mu\u0308nchen')).toBe(intakePathKey('c:\\scans\\M\u00fcnchen'));
    expect(intakeNameKey('Mu\u0308nchen')).toBe(intakeNameKey('M\u00dcNCHEN'));
  });

  it('the problem text never names the reserved segment or the stream', () => {
    expect(intakePathProblem('C:\\Scans\\NUL.secretname')).not.toContain('secretname');
    expect(intakePathProblem('C:\\Scans:secretstream')).not.toContain('secretstream');
  });
});

describe('intake folder fields', () => {
  it('accepts a full folder and defaults keepOriginals to false', () => {
    const { keepOriginals: _k, ...rest } = folder();
    expect(intakeFolderSchema.parse(rest)).toEqual(folder());
  });

  it('trims names', () => {
    expect(intakeFolderSchema.parse(folder({ name: '  Bills  ' })).name).toBe('Bills');
  });

  const bad: Array<[string, Record<string, unknown>, string]> = [
    ['id not a uuid', { id: 'folder-1' }, 'id'],
    ['empty name', { name: '' }, 'name'],
    ['blank name', { name: '   ' }, 'name'],
    ['name over 100', { name: 'n'.repeat(101) }, 'name'],
    ['name with control character', { name: 'Bills\u0007' }, 'name'],
    ['name with right-to-left override', { name: 'Bills\u202efdp.exe' }, 'name'],
    ['name with zero-width space', { name: 'Bi\u200blls' }, 'name'],
    ['name with line separator', { name: 'Bills\u2028x' }, 'name'],
    ['name with a lone surrogate', { name: 'Bills\ud800' }, 'name'],
    ['unknown kind', { defaultKind: 'invoices' }, 'defaultKind'],
    ['autoRead not boolean', { autoRead: 'yes' }, 'autoRead'],
    ['autoRead missing', { autoRead: undefined }, 'autoRead'],
    ['keepOriginals not boolean', { keepOriginals: 1 }, 'keepOriginals'],
    ['bad path', { path: 'relative\\x' }, 'path'],
    ['path not a string', { path: 42 }, 'path'],
  ];
  for (const [why, over, field] of bad) {
    it(`refuses ${why} at ${field}`, () => {
      const r = intakeFolderSchema.safeParse(folder(over));
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0]!.path).toEqual([field]);
    });
  }

  it('refuses unknown keys (strict)', () => {
    const r = intakeFolderSchema.safeParse(folder({ watch: true }));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]!.code).toBe('unrecognized_keys');
  });

  it('accepts a 100-character name', () => {
    expect(intakeFolderSchema.safeParse(folder({ name: 'n'.repeat(100) })).success).toBe(true);
  });
});

describe('intake folder list', () => {
  it('accepts 20 folders and refuses 21', () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => folder({ id: ID(i + 1), name: `F${i}`, path: `C:\\F${i}` }));
    expect(intakeFoldersSchema.safeParse(list(20)).success).toBe(true);
    const r = intakeFoldersSchema.safeParse(list(21));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]!.code).toBe('too_big');
  });

  const dup: Array<[string, Record<string, unknown>, Array<string | number>]> = [
    ['the same id', { id: ID(1).toUpperCase() }, [1, 'id']],
    ['the same name in another case', { name: 'BILLS' }, [1, 'name']],
    ['the same name after trimming', { name: ' Bills ' }, [1, 'name']],
    ['the same path in another case and separator', { path: 'c:/scans/bills/' }, [1, 'path']],
  ];
  for (const [why, over, at] of dup) {
    it(`refuses ${why}`, () => {
      const second = { ...folder({ id: ID(2), name: 'Receipts', path: 'C:\\Scans\\Receipts' }), ...over };
      const r = intakeFoldersSchema.safeParse([folder(), second]);
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues.map((i) => i.path)).toContainEqual(at);
    });
  }
});

describe('intake folder list, Unicode', () => {
  it('refuses a name or path that differs only in Unicode composition', () => {
    const a = folder({ name: 'M\u00fcnchen', path: 'C:\\Scans\\M\u00fcnchen' });
    const byName = intakeFoldersSchema.safeParse([a, folder({ id: ID(2), name: 'Mu\u0308nchen', path: 'C:\\Other' })]);
    expect(byName.success).toBe(false);
    if (!byName.success) expect(byName.error.issues.map((i) => i.path)).toContainEqual([1, 'name']);
    const byPath = intakeFoldersSchema.safeParse([a, folder({ id: ID(2), name: 'Other', path: 'C:\\Scans\\Mu\u0308nchen' })]);
    expect(byPath.success).toBe(false);
    if (!byPath.success) expect(byPath.error.issues.map((i) => i.path)).toContainEqual([1, 'path']);
  });
});

describe('PUT body', () => {
  it('needs expectedUpdatedAt (null allowed)', () => {
    expect(putIntakeSettingsSchema.safeParse({ folders: [] }).success).toBe(false);
    expect(putIntakeSettingsSchema.safeParse({ folders: [], expectedUpdatedAt: null }).success).toBe(true);
    expect(putIntakeSettingsSchema.safeParse({ folders: [], expectedUpdatedAt: '2026-10-25T12:00:00.123Z' }).success).toBe(true);
    expect(putIntakeSettingsSchema.safeParse({ folders: [], expectedUpdatedAt: 'yesterday' }).success).toBe(false);
  });

  it('refuses unknown keys', () => {
    expect(putIntakeSettingsSchema.safeParse({ folders: [], expectedUpdatedAt: null, version: 2 }).success).toBe(false);
  });

  it('reports the field path of a nested problem', () => {
    const r = putIntakeSettingsSchema.safeParse({ folders: [folder(), folder({ id: ID(2), name: 'R', path: '\\\\?\\C:\\x' })], expectedUpdatedAt: null });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]!.path).toEqual(['folders', 1, 'path']);
  });
});

describe('default', () => {
  it('is version 1 with no folders, never saved', () => {
    expect(JSON.parse(INTAKE_SETTINGS_DEFAULT_JSON)).toEqual({ version: 1, folders: [], updatedAt: null });
  });
});
