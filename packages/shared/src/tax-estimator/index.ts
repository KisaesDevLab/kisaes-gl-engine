// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator — shared surface (features/tax-estimator/MODULE.md).
// The calculation engine under ./engine is PURE (no IO, no DB) and lives in
// @kis-books/shared so the browser preview and the server PDF/portal compute
// identical numbers (same pattern as financial-statements/, rule TB14).
export * from './types.js';
export * from './parameterKeys.js';
export * from './engine/index.js';
