// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator — shared surface (features/tax-estimator/MODULE.md).
// The calculation engine under ./engine is PURE (no IO, no DB) and lives in
// @kis-books/shared so the browser preview and the server PDF/portal compute
// identical numbers (same pattern as financial-statements/, rule TB14).
export * from './types.js';
export * from './parameterKeys.js';
export * from './parameter-api.js';
export * from './taxpayers-api.js';
export * from './outside-entities-api.js';
export * from './projection-method.js';
export * from './stateRuleKeys.js';
export * from './installment-shape.js';
export * from './format-text.js';
export * from './dates.js';
export * from './engine/index.js';
export * from './state-rules-api.js';
export * from './entities-api.js';
// Q50: owner splits on person-target treatments (pct / fixed amount).
export * from './treatment-splits.js';
export * from './years-api.js';
export * from './estimate-api.js';
// Phase 10b bridge helper (kept out of engine/index.ts, which the engine owner maintains).
export { personYearInputsFromDto } from './engine/bridge.js';
export * from './allocation.js';
export * from './decimal.js';
export * from './assumptions.js';
export * from './snapshots-api.js';
export * from './portal-api.js';
// Q51: the client portal's calculation summary (server-side allow-list projection).
export * from './portal-summary.js';
export * from './installments-as-of.js';
// The Calculation view's lines (web Calculation table + estimate PDF "Detailed calculation").
export * from './calc-lines.js';
export * from './entity-type-override.js';
// AI parameter check (OPEN-QUESTIONS Q48): trusted sources, wire types, server-side validator.
export * from './ai-check-sources.js';
export * from './ai-check-api.js';
export * from './ai-check-validate.js';
// Dashboard cards (Q52): company + firm-wide card DTOs and the as-of selection helpers.
export * from './dashboard-api.js';
