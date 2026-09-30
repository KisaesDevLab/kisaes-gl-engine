// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Report-ready financial statements (FINANCIAL_STATEMENTS_V1, TB module).
// Zod contracts shared by the API (persistence + server compute), the web
// editor (live preview) and every renderer. The statement LAYOUT is a tree
// of nodes sitting on top of TB leadsheets (tb_groupings); the STYLE is a
// separate object so firm presets can be applied to any layout.

import { z } from 'zod';
import { FS_FONT_KEYS } from './fonts.js';

export const FS_STATEMENT_KINDS = ['balance_sheet', 'income_statement', 'equity', 'cash_flows'] as const;
export type FsStatementKind = (typeof FS_STATEMENT_KINDS)[number];

export const FS_FRAMEWORKS = ['gaap', 'cash', 'tax'] as const;
export type FsFramework = (typeof FS_FRAMEWORKS)[number];

export const FS_ENTITY_KINDS = ['corporation', 'partnership', 'llc', 'sole_prop'] as const;
export type FsEntityKind = (typeof FS_ENTITY_KINDS)[number];

export const FS_CF_CLASSES = ['cash', 'operating', 'noncash_adjustment', 'investing', 'financing', 'excluded'] as const;
export type FsCashFlowClass = (typeof FS_CF_CLASSES)[number];

// Special roles the engine checks: BS must balance, IS net income must
// equal the P&L total, and each role is a rounding anchor.
export const FS_NODE_ROLES = ['total_assets', 'total_liabilities_equity', 'net_income'] as const;
export type FsNodeRole = (typeof FS_NODE_ROLES)[number];

const nodeId = z.string().trim().min(1).max(40);
const caption = z.string().max(200);

// An account reference inside a layout. Client layouts may use accountId;
// firm templates may only use systemTag (see fsTemplateLayoutSchema).
export const fsAccountRefSchema = z.object({
  accountId: z.string().uuid().optional(),
  systemTag: z.string().trim().min(1).max(60).optional(),
}).refine((r) => (r.accountId ? 1 : 0) + (r.systemTag ? 1 : 0) === 1, {
  message: 'Account reference needs exactly one of accountId or systemTag',
});
export type FsAccountRef = z.infer<typeof fsAccountRefSchema>;

export const fsRuleSchema = z.enum(['none', 'single', 'double']);
export type FsRule = z.infer<typeof fsRuleSchema>;

export const fsPolaritySchema = z.enum(['debit', 'credit']);
export type FsPolarity = z.infer<typeof fsPolaritySchema>;

export const fsNodeStyleSchema = z.object({
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  // Extra indent levels on top of the tree depth.
  indent: z.number().int().min(-4).max(6).optional(),
  // Point-size delta vs the element style.
  sizeDelta: z.number().min(-4).max(8).optional(),
  caps: z.boolean().optional(),
}).strict();
export type FsNodeStyle = z.infer<typeof fsNodeStyleSchema>;

const commonNode = {
  id: nodeId,
  style: fsNodeStyleSchema.optional(),
  ruleAbove: z.enum(['none', 'single']).optional(),
  ruleBelow: fsRuleSchema.optional(),
  // Hide when every rounded amount column is zero (the style's
  // number.hideZeroLines applies when this is unset).
  hideWhenZero: z.boolean().optional(),
  // Force a page break before this node.
  breakBefore: z.boolean().optional(),
};

export const fsScheduleLineSchema = z.object({
  id: nodeId,
  // Omitted = the account's own name (single account) — required in
  // practice when several accounts are combined.
  caption: caption.optional(),
  accountRefs: z.array(fsAccountRefSchema).min(1).max(200),
});
export type FsScheduleLine = z.infer<typeof fsScheduleLineSchema>;

export const FS_LEADSHEET_DISPLAYS = ['single_line', 'detail', 'summary_with_schedule'] as const;
export type FsLeadsheetDisplay = (typeof FS_LEADSHEET_DISPLAYS)[number];

export interface FsSectionNode {
  type: 'section';
  id: string;
  caption: string;
  showHeading?: boolean;
  polarity?: FsPolarity;
  children: FsNode[];
  showTotal?: boolean;
  totalCaption?: string;
  role?: FsNodeRole;
  anchor?: boolean;
  revenueBase?: boolean;
  totalStyle?: FsNodeStyle;
  totalRuleAbove?: 'none' | 'single';
  totalRuleBelow?: FsRule;
  style?: FsNodeStyle;
  ruleAbove?: 'none' | 'single';
  ruleBelow?: FsRule;
  hideWhenZero?: boolean;
  breakBefore?: boolean;
}

export interface FsLeadsheetNode {
  type: 'leadsheet';
  id: string;
  ref: { groupingId?: string; leadsheetCode?: string };
  caption?: string;
  display: FsLeadsheetDisplay;
  polarity?: FsPolarity;
  scheduleTitle?: string;
  scheduleLines?: FsScheduleLine[];
  revenueBase?: boolean;
  anchor?: boolean;
  style?: FsNodeStyle;
  ruleAbove?: 'none' | 'single';
  ruleBelow?: FsRule;
  hideWhenZero?: boolean;
  breakBefore?: boolean;
}

export interface FsAccountNode {
  type: 'account';
  id: string;
  refs: FsAccountRef[];
  caption: string;
  polarity?: FsPolarity;
  revenueBase?: boolean;
  style?: FsNodeStyle;
  ruleAbove?: 'none' | 'single';
  ruleBelow?: FsRule;
  hideWhenZero?: boolean;
  breakBefore?: boolean;
}

export interface FsTotalNode {
  type: 'total';
  id: string;
  caption: string;
  terms: Array<{ nodeId: string; sign: 1 | -1 }>;
  role?: FsNodeRole;
  anchor?: boolean;
  revenueBase?: boolean;
  style?: FsNodeStyle;
  ruleAbove?: 'none' | 'single';
  ruleBelow?: FsRule;
  hideWhenZero?: boolean;
  breakBefore?: boolean;
}

export interface FsTextNode {
  type: 'text';
  id: string;
  text: string;
  style?: FsNodeStyle;
  ruleAbove?: 'none' | 'single';
  ruleBelow?: FsRule;
  hideWhenZero?: boolean;
  breakBefore?: boolean;
}

export interface FsSpacerNode {
  type: 'blank' | 'page_break';
  id: string;
  style?: FsNodeStyle;
  ruleAbove?: 'none' | 'single';
  ruleBelow?: FsRule;
  hideWhenZero?: boolean;
  breakBefore?: boolean;
}

export type FsNode = FsSectionNode | FsLeadsheetNode | FsAccountNode | FsTotalNode | FsTextNode | FsSpacerNode;

export const fsNodeSchema: z.ZodType<FsNode> = z.lazy(() => z.discriminatedUnion('type', [
  z.object({
    ...commonNode,
    type: z.literal('section'),
    caption,
    showHeading: z.boolean().optional(),
    polarity: fsPolaritySchema.optional(),
    children: z.array(fsNodeSchema).max(300),
    showTotal: z.boolean().optional(),
    totalCaption: caption.optional(),
    role: z.enum(FS_NODE_ROLES).optional(),
    anchor: z.boolean().optional(),
    revenueBase: z.boolean().optional(),
    totalStyle: fsNodeStyleSchema.optional(),
    totalRuleAbove: z.enum(['none', 'single']).optional(),
    totalRuleBelow: fsRuleSchema.optional(),
  }),
  z.object({
    ...commonNode,
    type: z.literal('leadsheet'),
    ref: z.object({
      groupingId: z.string().uuid().optional(),
      leadsheetCode: z.string().trim().min(1).max(10).optional(),
    }).refine((r) => !!(r.groupingId || r.leadsheetCode), { message: 'Leadsheet reference is empty' }),
    caption: caption.optional(),
    display: z.enum(FS_LEADSHEET_DISPLAYS),
    polarity: fsPolaritySchema.optional(),
    scheduleTitle: caption.optional(),
    scheduleLines: z.array(fsScheduleLineSchema).max(300).optional(),
    revenueBase: z.boolean().optional(),
    anchor: z.boolean().optional(),
  }),
  z.object({
    ...commonNode,
    type: z.literal('account'),
    refs: z.array(fsAccountRefSchema).min(1).max(200),
    caption,
    polarity: fsPolaritySchema.optional(),
    revenueBase: z.boolean().optional(),
  }),
  z.object({
    ...commonNode,
    type: z.literal('total'),
    caption,
    terms: z.array(z.object({ nodeId, sign: z.union([z.literal(1), z.literal(-1)]) })).min(1).max(50),
    role: z.enum(FS_NODE_ROLES).optional(),
    anchor: z.boolean().optional(),
    revenueBase: z.boolean().optional(),
  }),
  z.object({ ...commonNode, type: z.literal('text'), text: z.string().max(2000) }),
  z.object({ ...commonNode, type: z.enum(['blank', 'page_break']) }),
]) as unknown as z.ZodType<FsNode>);

export const FS_PAPERS = ['letter', 'legal', 'a4'] as const;
export type FsPaper = (typeof FS_PAPERS)[number];

export const fsMarginsSchema = z.object({
  top: z.number().min(0.25).max(3),
  right: z.number().min(0.25).max(3),
  bottom: z.number().min(0.25).max(3),
  left: z.number().min(0.25).max(3),
});
export type FsMargins = z.infer<typeof fsMarginsSchema>;

export const fsPageSetupSchema = z.object({
  paper: z.enum(FS_PAPERS),
  orientation: z.enum(['portrait', 'landscape']),
  margins: fsMarginsSchema,
});
export type FsPageSetup = z.infer<typeof fsPageSetupSchema>;

export const fsEquityCaptionsSchema = z.object({
  beginning: caption.optional(),
  netIncome: caption.optional(),
  contributions: caption.optional(),
  distributions: caption.optional(),
  other: caption.optional(),
  ending: caption.optional(),
  total: caption.optional(),
}).strict();

export const fsCashFlowCaptionsSchema = z.object({
  operatingHeading: caption.optional(),
  netIncome: caption.optional(),
  adjustmentsHeading: caption.optional(),
  changesHeading: caption.optional(),
  netOperating: caption.optional(),
  investingHeading: caption.optional(),
  netInvesting: caption.optional(),
  financingHeading: caption.optional(),
  netFinancing: caption.optional(),
  netChange: caption.optional(),
  beginningCash: caption.optional(),
  endingCash: caption.optional(),
}).strict();

export const fsStatementConfigSchema = z.object({
  id: nodeId,
  kind: z.enum(FS_STATEMENT_KINDS),
  enabled: z.boolean(),
  titleOverride: caption.optional(),
  pageSetup: fsPageSetupSchema.partial().optional(),
  // Rounding plug target per anchor node (anchorNodeId → leaf nodeId).
  plugs: z.record(nodeId, nodeId).optional(),
  body: z.array(fsNodeSchema).max(300),
  equity: z.object({
    captions: fsEquityCaptionsSchema.optional(),
    // 'auto' = per-account columns for corporations, one column otherwise.
    columns: z.enum(['auto', 'single', 'by_account']).optional(),
    // Per-column caption overrides keyed by account id.
    columnCaptions: z.record(z.string(), caption).optional(),
  }).optional(),
  cashFlow: z.object({
    captions: fsCashFlowCaptionsSchema.optional(),
    // Show each account change as its own line (true) or one line per leadsheet (false).
    detailByAccount: z.boolean().optional(),
  }).optional(),
});
export type FsStatementConfig = z.infer<typeof fsStatementConfigSchema>;

export const fsLayoutSchema = z.object({
  version: z.literal(1),
  statements: z.array(fsStatementConfigSchema).min(1).max(8),
  schedules: z.object({
    enabled: z.boolean(),
    dividerTitle: caption,
    numbering: z.enum(['numeric', 'alpha']),
  }),
});
export type FsLayout = z.infer<typeof fsLayoutSchema>;

// Walk every node (depth-first) — used by refines, binding and the engine.
export function walkFsNodes(nodes: FsNode[], visit: (n: FsNode, depth: number) => void, depth = 0): void {
  for (const n of nodes) {
    visit(n, depth);
    if (n.type === 'section') walkFsNodes(n.children, visit, depth + 1);
  }
}

function layoutIssues(layout: FsLayout, portable: boolean): string[] {
  const issues: string[] = [];
  for (const st of layout.statements) {
    const ids = new Set<string>();
    walkFsNodes(st.body, (n) => {
      if (ids.has(n.id)) issues.push(`Duplicate node id "${n.id}" in ${st.kind}`);
      ids.add(n.id);
      if (!portable) return;
      if (n.type === 'leadsheet') {
        if (n.ref.groupingId) issues.push(`Template leadsheet "${n.id}" references a client grouping`);
        if (n.scheduleLines?.some((l) => l.accountRefs.some((r) => r.accountId))) {
          issues.push(`Template leadsheet "${n.id}" references client accounts`);
        }
      }
      if (n.type === 'account' && n.refs.some((r) => r.accountId)) {
        issues.push(`Template line "${n.id}" references client accounts`);
      }
    });
    for (const [k, v] of Object.entries(st.plugs ?? {})) {
      if (!ids.has(k) || !ids.has(v)) issues.push(`Rounding plug ${k}→${v} references a missing node`);
    }
  }
  return issues;
}

export const fsClientLayoutSchema = fsLayoutSchema.superRefine((l, ctx) => {
  for (const msg of layoutIssues(l, false)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: msg });
});

// Firm templates are portable: no client grouping / account UUIDs.
export const fsTemplateLayoutSchema = fsLayoutSchema.superRefine((l, ctx) => {
  for (const msg of layoutIssues(l, true)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: msg });
});

// ─── Style ─────────────────────────────────────────────────────────

export const fsElementStyleSchema = z.object({
  sizePt: z.number().min(6).max(28),
  bold: z.boolean(),
  italic: z.boolean(),
  caps: z.boolean().optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
});
export type FsElementStyle = z.infer<typeof fsElementStyleSchema>;

export const FS_STYLE_ELEMENTS = [
  'companyName', 'statementTitle', 'dateLine', 'columnHeader', 'sectionHeading',
  'detail', 'subtotal', 'total', 'text', 'footer',
] as const;
export type FsStyleElement = (typeof FS_STYLE_ELEMENTS)[number];

export const FS_PAGE_NUMBER_FORMATS = ['n', 'dash_n', 'page_n', 'page_n_of_total', 'none'] as const;
export type FsPageNumberFormat = (typeof FS_PAGE_NUMBER_FORMATS)[number];

export const fsStyleSchema = z.object({
  fontKey: z.enum(FS_FONT_KEYS),
  baseSizePt: z.number().min(7).max(16),
  lineHeight: z.number().min(1).max(2.2),
  indentPt: z.number().min(4).max(36),
  amountColumnWidthIn: z.number().min(0.6).max(2.5),
  number: z.object({
    decimals: z.union([z.literal(0), z.literal(2)]),
    dollarSigns: z.enum(['first_and_totals', 'none']),
    negative: z.enum(['parens', 'minus']),
    zero: z.enum(['dash', 'zero']),
    hideZeroLines: z.boolean(),
  }),
  elements: z.object(
    Object.fromEntries(FS_STYLE_ELEMENTS.map((k) => [k, fsElementStyleSchema])) as Record<FsStyleElement, typeof fsElementStyleSchema>,
  ),
  page: fsPageSetupSchema,
  titleBlock: z.object({ align: z.enum(['left', 'center']) }),
  footer: z.object({
    text: z.string().max(300),
    onStatements: z.boolean(),
    onSchedules: z.boolean(),
    pageNumber: z.object({
      format: z.enum(FS_PAGE_NUMBER_FORMATS),
      position: z.enum(['bottom_center', 'bottom_right']),
    }),
  }),
});
export type FsStyle = z.infer<typeof fsStyleSchema>;

// ─── Report settings / front matter ────────────────────────────────

// 'month_ytd' is the pre-period legacy name of 'period_ytd' (a month period).
export const FS_COLUMN_MODES = ['single', 'cy_py', 'period_ytd', 'period_ytd_py', 'side_by_side', 'month_ytd'] as const;
export type FsColumnMode = (typeof FS_COLUMN_MODES)[number];

export const FS_PERIOD_TYPES = ['annual', 'quarter', 'month', 'ytd', 'custom'] as const;
export type FsPeriodType = (typeof FS_PERIOD_TYPES)[number];

export const fsColumnsConfigSchema = z.object({
  mode: z.enum(FS_COLUMN_MODES),
  pctOfRevenue: z.boolean(),
  varianceAmt: z.boolean(),
  variancePct: z.boolean(),
  // Side-by-side slices.
  sideBy: z.enum(['month', 'quarter']).optional(),
  // Comparative balance sheet column: prior fiscal year-end (interim
  // convention) or the same date one year earlier.
  bsCompare: z.enum(['prior_fye', 'same_date']).optional(),
});
export type FsColumnsConfig = z.infer<typeof fsColumnsConfigSchema>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const fsPeriodSchema = z.object({
  type: z.enum(FS_PERIOD_TYPES),
  start: isoDate,
});
export type FsPeriod = z.infer<typeof fsPeriodSchema>;

// Whole months from the first day of `start`'s month through `end`'s month.
function monthsSpanned(start: string, end: string): number {
  const [sy, sm] = start.split('-').map(Number) as [number, number];
  const [ey, em] = end.split('-').map(Number) as [number, number];
  return (ey - sy) * 12 + (em - sm) + 1;
}

export const fsReportSettingsSchema = z.object({
  // End of the reporting period (balance-sheet date).
  periodEnd: isoDate,
  // Absent on reports created before reporting periods existed: they are
  // fiscal-year-to-date (normalizeFsSettings).
  period: fsPeriodSchema.optional(),
  framework: z.enum(FS_FRAMEWORKS),
  // Book basis for gaap/cash frameworks; 'cash' framework forces cash.
  bookBasis: z.enum(['accrual', 'cash']),
  columns: fsColumnsConfigSchema,
  // Income statement only; the balance sheet never segments.
  tagId: z.string().uuid().nullable().optional(),
}).superRefine((s, ctx) => {
  const mode = s.columns.mode;
  if (s.period && s.period.start > s.periodEnd) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'The period start must be on or before the period end.', path: ['period', 'start'] });
  }
  if (s.framework === 'tax') {
    if ((s.period && s.period.type !== 'annual') || mode === 'month_ytd' || mode === 'period_ytd' || mode === 'period_ytd_py' || mode === 'side_by_side') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Income-tax-basis statements are annual only (tax adjustments are not dated).', path: ['period', 'type'] });
    }
  }
  if (mode === 'side_by_side') {
    const start = s.period?.start;
    if (!start) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Side-by-side columns need a reporting period.', path: ['columns', 'mode'] });
    } else {
      const months = monthsSpanned(start, s.periodEnd);
      const slices = s.columns.sideBy === 'quarter' ? Math.ceil(months / 3) : months;
      if (slices < 2 || slices > 13) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Side-by-side needs 2 to 13 ${s.columns.sideBy === 'quarter' ? 'quarters' : 'months'} (this period has ${slices}).`, path: ['columns', 'sideBy'] });
      }
    }
  }
});
export type FsReportSettings = z.infer<typeof fsReportSettingsSchema>;

export const fsFrontMatterSchema = z.object({
  cover: z.object({
    enabled: z.boolean(),
    title: caption.optional(),
    subtitle: caption.optional(),
    showFirmName: z.boolean().optional(),
  }),
  toc: z.object({ enabled: z.boolean(), title: caption.optional() }),
  letter: z.object({
    enabled: z.boolean(),
    letterId: z.string().uuid().nullable().optional(),
    // Per-engagement tweaks; null/undefined = use the library letter.
    titleOverride: caption.nullable().optional(),
    bodyHtmlOverride: z.string().max(3_000_000).nullable().optional(),
    reportDate: isoDate.nullable().optional(),
  }),
});
export type FsFrontMatter = z.infer<typeof fsFrontMatterSchema>;

// ─── API inputs ────────────────────────────────────────────────────

export const fsCreateReportSchema = z.object({
  name: z.string().trim().min(1).max(200),
  settings: fsReportSettingsSchema,
  // Where the layout comes from: an existing company layout, a firm
  // template (bound on copy), or the built-in default.
  layoutSource: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('company_layout'), companyLayoutId: z.string().uuid() }),
    z.object({
      kind: z.literal('template'),
      templateId: z.string().uuid(),
      layoutName: z.string().trim().min(1).max(200).optional(),
      resolutions: z.record(z.string(), z.string().uuid().nullable()).optional(),
    }),
    z.object({ kind: z.literal('default'), layoutName: z.string().trim().min(1).max(200).optional() }),
  ]),
  stylePresetId: z.string().uuid().nullable().optional(),
  frontMatter: fsFrontMatterSchema.optional(),
});
export type FsCreateReportInput = z.infer<typeof fsCreateReportSchema>;

export const fsUpdateReportSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  settings: fsReportSettingsSchema.optional(),
  frontMatter: fsFrontMatterSchema.optional(),
});
export type FsUpdateReportInput = z.infer<typeof fsUpdateReportSchema>;

export const fsUpdateCompanyLayoutSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  layout: fsClientLayoutSchema.optional(),
  style: fsStyleSchema.optional(),
  expectedUpdatedAt: z.string().optional(),
});
export type FsUpdateCompanyLayoutInput = z.infer<typeof fsUpdateCompanyLayoutSchema>;

// Unsaved-draft compute / preview: any subset overrides the saved state.
export const fsDraftOverridesSchema = z.object({
  layout: fsClientLayoutSchema.optional(),
  style: fsStyleSchema.optional(),
  settings: fsReportSettingsSchema.optional(),
  frontMatter: fsFrontMatterSchema.optional(),
});
export type FsDraftOverrides = z.infer<typeof fsDraftOverridesSchema>;

export const fsFinalizeSchema = z.object({
  overrideValidation: z.boolean().optional(),
  reason: z.string().trim().max(1000).optional(),
}).refine((v) => !v.overrideValidation || (v.reason && v.reason.length >= 5), {
  message: 'A reason (5+ characters) is required to finalize with validation errors',
  path: ['reason'],
});

export const fsPublishSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  archivePrevious: z.boolean().optional(),
});

export const fsCashFlowOverridesSchema = z.object({
  overrides: z.array(z.object({
    accountId: z.string().uuid().nullable().optional(),
    groupingId: z.string().uuid().nullable().optional(),
    classification: z.enum(FS_CF_CLASSES).nullable(), // null = remove override
  }).refine((o) => (o.accountId ? 1 : 0) + (o.groupingId ? 1 : 0) === 1, {
    message: 'Override needs exactly one of accountId or groupingId',
  })).max(1000),
});

const MAX_LOGO_DATA_URI = 700 * 1024 * 4 / 3 + 64; // ~700 KB image
export const fsLetterheadSchema = z.object({
  displayName: z.string().trim().max(200).nullable().optional(),
  addressLine1: z.string().trim().max(200).nullable().optional(),
  addressLine2: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().max(100).nullable().optional(),
  state: z.string().trim().max(50).nullable().optional(),
  postalCode: z.string().trim().max(20).nullable().optional(),
  phone: z.string().trim().max(50).nullable().optional(),
  email: z.string().trim().max(200).nullable().optional(),
  website: z.string().trim().max(200).nullable().optional(),
  logoDataUri: z.string().max(MAX_LOGO_DATA_URI)
    .regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/, 'Logo must be a PNG or JPEG')
    .nullable().optional(),
  accountantSignature: z.string().trim().max(300).nullable().optional(),
  letterheadAlign: z.enum(['left', 'center']).optional(),
});
export type FsLetterheadInput = z.infer<typeof fsLetterheadSchema>;

export const fsLetterSchema = z.object({
  name: z.string().trim().min(1).max(200),
  letterType: z.enum(['compilation', 'preparation']),
  title: z.string().trim().max(200).nullable().optional(),
  bodyHtml: z.string().max(3_000_000),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
export type FsLetterInput = z.infer<typeof fsLetterSchema>;

export const fsStylePresetSchema = z.object({
  name: z.string().trim().min(1).max(200),
  style: fsStyleSchema,
  isDefault: z.boolean().optional(),
});
export type FsStylePresetInput = z.infer<typeof fsStylePresetSchema>;

export const fsLayoutTemplateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).nullable().optional(),
  entityKind: z.enum([...FS_ENTITY_KINDS, 'any']),
  layout: fsTemplateLayoutSchema,
  isDefault: z.boolean().optional(),
});
export type FsLayoutTemplateInput = z.infer<typeof fsLayoutTemplateSchema>;

export const fsCompanyEntityKind = (entityType: string | null | undefined): FsEntityKind => {
  switch (entityType) {
    case 's_corp':
    case 'c_corp':
      return 'corporation';
    case 'partnership':
      return 'partnership';
    case 'single_member_llc':
      return 'llc';
    case 'sole_prop':
      return 'sole_prop';
    default:
      return 'corporation';
  }
};
