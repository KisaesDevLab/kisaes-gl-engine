// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
/**
 * Environment for helper processes the engine starts (poppler's pdftoppm,
 * pdftotext, pdfimages). On the server they inherit the environment, as
 * before. In desktop mode they get only what a command-line tool needs to
 * run and find its libraries and fonts, so JWT_SECRET, ENCRYPTION_KEY,
 * DATABASE_URL, provider API keys and the like never reach them.
 */

import { isDesktop } from './profile.js';

const ALLOWED = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|LANG|LANGUAGE|TZ|LC_[A-Z]+|LD_LIBRARY_PATH|DYLD_LIBRARY_PATH|DYLD_FALLBACK_LIBRARY_PATH|FONTCONFIG_FILE|FONTCONFIG_PATH|XDG_DATA_DIRS|XDG_CONFIG_HOME|XDG_CACHE_HOME)$/i;
// Belt and braces: never pass anything credential-named, even if allowed.
const SECRET_NAME = /KEY|SECRET|PASS|TOKEN/i;

/** Minimal env from `source` (exported for tests). */
export function minimalChildEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && ALLOWED.test(name) && !SECRET_NAME.test(name)) out[name] = value;
  }
  return out;
}

/** `env` option for execFile/spawn: undefined (inherit) on the server. */
export function childProcessEnv(): NodeJS.ProcessEnv | undefined {
  return isDesktop() ? minimalChildEnv(process.env) : undefined;
}
