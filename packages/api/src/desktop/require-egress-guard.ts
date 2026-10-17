// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Side-effect module: imported FIRST by index.ts. Desktop mode never runs
 * without the egress guard (bootstrap.ts installs it before importing
 * index.ts). Reaching index.ts without it means the engine was started some
 * other way: refuse with exit 78 EGRESS_GUARD_MISSING rather than run with
 * open egress.
 *
 * It has to be its own module because ES imports are evaluated before the
 * importing module's body. A check written in index.ts runs only after app,
 * db, services and the schedulers have loaded, so any earlier import-time
 * failure (or a slow cold load) would win the race and exit 1 instead.
 * Imports here are limited to env-free modules.
 */

import { isDesktop } from './profile.js';
import { desktopFatal } from './fatal.js';
import { isEgressGuardInstalled } from './egress-guard.js';

if (isDesktop() && !isEgressGuardInstalled()) {
  desktopFatal('EGRESS_GUARD_MISSING', 'desktop mode requires the egress guard; start the engine through bootstrap.');
}
