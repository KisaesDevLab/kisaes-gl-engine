// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';
import { AL_RULES } from './AL.js';
import { AK_RULES } from './AK.js';
import { AZ_RULES } from './AZ.js';
import { AR_RULES } from './AR.js';
import { CA_RULES } from './CA.js';
import { CO_RULES } from './CO.js';
import { CT_RULES } from './CT.js';
import { DE_RULES } from './DE.js';
import { DC_RULES } from './DC.js';
import { FL_RULES } from './FL.js';
import { GA_RULES } from './GA.js';
import { HI_RULES } from './HI.js';
import { ID_RULES } from './ID.js';
import { IL_RULES } from './IL.js';
import { IN_RULES } from './IN.js';
import { IA_RULES } from './IA.js';
import { KS_RULES } from './KS.js';
import { KY_RULES } from './KY.js';
import { LA_RULES } from './LA.js';
import { ME_RULES } from './ME.js';
import { MD_RULES } from './MD.js';
import { MA_RULES } from './MA.js';
import { MI_RULES } from './MI.js';
import { MN_RULES } from './MN.js';
import { MS_RULES } from './MS.js';
import { MO_RULES } from './MO.js';
import { MT_RULES } from './MT.js';
import { NE_RULES } from './NE.js';
import { NV_RULES } from './NV.js';
import { NH_RULES } from './NH.js';
import { NJ_RULES } from './NJ.js';
import { NM_RULES } from './NM.js';
import { NY_RULES } from './NY.js';
import { NC_RULES } from './NC.js';
import { ND_RULES } from './ND.js';
import { OH_RULES } from './OH.js';
import { OK_RULES } from './OK.js';
import { OR_RULES } from './OR.js';
import { PA_RULES } from './PA.js';
import { RI_RULES } from './RI.js';
import { SC_RULES } from './SC.js';
import { SD_RULES } from './SD.js';
import { TN_RULES } from './TN.js';
import { TX_RULES } from './TX.js';
import { UT_RULES } from './UT.js';
import { VT_RULES } from './VT.js';
import { VA_RULES } from './VA.js';
import { WA_RULES } from './WA.js';
import { WV_RULES } from './WV.js';
import { WI_RULES } from './WI.js';
import { WY_RULES } from './WY.js';
import { STATE_EXEMPTION_RULES } from './exemptions.js';
import { STATE_RATE_SCHEDULE_RULES } from './rate-schedules.js';

/** Every shipped state-rule seed row (all states, all years). */
export const STATE_RULE_SEEDS: readonly StateRuleSeedRow[] = [
  ...AL_RULES, ...AK_RULES, ...AZ_RULES, ...AR_RULES, ...CA_RULES, ...CO_RULES, ...CT_RULES, ...DE_RULES, ...DC_RULES, ...FL_RULES, ...GA_RULES, ...HI_RULES, ...ID_RULES, ...IL_RULES, ...IN_RULES, ...IA_RULES, ...KS_RULES, ...KY_RULES, ...LA_RULES, ...ME_RULES, ...MD_RULES, ...MA_RULES, ...MI_RULES, ...MN_RULES, ...MS_RULES, ...MO_RULES, ...MT_RULES, ...NE_RULES, ...NV_RULES, ...NH_RULES, ...NJ_RULES, ...NM_RULES, ...NY_RULES, ...NC_RULES, ...ND_RULES, ...OH_RULES, ...OK_RULES, ...OR_RULES, ...PA_RULES, ...RI_RULES, ...SC_RULES, ...SD_RULES, ...TN_RULES, ...TX_RULES, ...UT_RULES, ...VT_RULES, ...VA_RULES, ...WA_RULES, ...WV_RULES, ...WI_RULES, ...WY_RULES,
  // Q44: personal / dependent exemptions (one row per income-tax state and year).
  ...STATE_EXEMPTION_RULES,
  // Q53: rate schedules, standard deduction, starting point, capital gains (+ AL / MO / OR federal tax
  // deduction, WA capital gains excise).
  ...STATE_RATE_SCHEDULE_RULES,
];
