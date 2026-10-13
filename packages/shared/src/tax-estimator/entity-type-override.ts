// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Q49: display text for the per-tax-year entity type override (OPEN-QUESTIONS.md Q49). One source
// for the API warning, the Calculation view chip, the assumptions line and the web setup page, so
// they all say the same thing. Preparer-facing only: client deliverables show the effective type.
import type { EntityTypeOverrideInfo } from './entities-api.js';

const SHORT_LABEL: Record<string, string> = {
  sch_c: 'Sch C', sch_f: 'Sch F', s_corp: 'S corp', partnership: 'Partnership', c_corp: 'C corp',
};

/** Short entity-type label ("S corp", "Sch C", ...), the Calculation view's vocabulary. */
export function entityTypeShortLabel(t: string | null | undefined): string {
  if (!t) return 'not set';
  return SHORT_LABEL[t] ?? t.replace(/_/g, ' ');
}

/** What the type would otherwise have been: "TB profile says 1065", "estimator setting says S corp", ... */
export function entityTypeOverrideBaseText(o: EntityTypeOverrideInfo): string {
  switch (o.baseEntityTypeSource) {
    case 'tb_profile': return `TB profile says ${o.tbReturnForm ?? entityTypeShortLabel(o.baseEntityType)}`;
    case 'estimator_setting': return `estimator setting says ${entityTypeShortLabel(o.baseEntityType)}`;
    case 'company_entity_type': return `company entity type says ${entityTypeShortLabel(o.baseEntityType)}`;
    default: return 'no other entity type is set';
  }
}

/** "Entity type overridden: S corp (TB profile says 1065)" — the Calculation view chip. */
export function entityTypeOverrideText(o: EntityTypeOverrideInfo): string {
  return `Entity type overridden: ${entityTypeShortLabel(o.overrideType)} (${entityTypeOverrideBaseText(o)})`;
}

/** "Entity type overridden for 2026: S corp (TB profile says 1065)" — warning / assumptions wording. */
export function entityTypeOverrideYearText(o: EntityTypeOverrideInfo): string {
  return `Entity type overridden for ${o.taxYear}: ${entityTypeShortLabel(o.overrideType)} (${entityTypeOverrideBaseText(o)})`;
}
