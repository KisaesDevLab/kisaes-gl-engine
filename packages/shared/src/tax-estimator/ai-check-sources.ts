// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Trusted sources for the AI parameter check (OPEN-QUESTIONS Q44, Kurt 2026-10-13: "government
// only"). The AI check may use ONLY pages retrieved from these domains during the call; the
// Anthropic web search / web fetch tools get them as `allowed_domains`, and the server re-checks
// every cited URL against the same list after the model answers (ai-check-validate.ts).
//
// Hostnames, no scheme or path. A listed domain also covers its subdomains (www.irs.gov,
// apps.irs.gov), matching the Anthropic tools' allowed_domains semantics.
//
// Federal list — statute, regulations and IRS guidance:
//   irs.gov              Rev. Procs., notices, forms and instructions, publications
//   uscode.house.gov     official U.S. Code (Office of the Law Revision Counsel)
//   law.cornell.edu      LII statute / CFR text (mirror of the official text, widely cited)
//   ecfr.gov             electronic Code of Federal Regulations
//   federalregister.gov  Federal Register (final / temporary regulations)
//   govinfo.gov          GPO: Internal Revenue Bulletin, public laws, CFR PDFs
//   congress.gov         enacted bills / public laws (e.g. P.L. 119-21)
//   ssa.gov              Social Security wage base (contribution and benefit base)
//
// State list — for each jurisdiction its revenue department and its official statute
// publisher (legislature / revisor of statutes). Each entry is the department's or
// legislature's own domain: *.gov where the state uses it, otherwise the state's official
// non-.gov domain (e.g. Florida DOR floridarevenue.com, Kansas Revisor ksrevisor.org). A few
// states publish their revenue department under the state portal (portal.ct.gov, in.gov,
// maine.gov, mass.gov, michigan.gov, nj.gov, oklahoma.gov, oregon.gov, tn.gov); the portal
// domain is listed because the tools cannot restrict web fetch by path. Reviewed 2026-10-13
// from the agencies' published addresses — re-check when a state moves its site.
// A state-rule check is allowed the federal list PLUS that state's domains only.
import type { StateCode } from './stateRuleKeys.js';

export const FEDERAL_TRUSTED_DOMAINS: readonly string[] = [
  'irs.gov', 'uscode.house.gov', 'law.cornell.edu', 'ecfr.gov', 'federalregister.gov', 'govinfo.gov', 'congress.gov', 'ssa.gov',
];

export const STATE_TRUSTED_DOMAINS: Readonly<Record<StateCode, readonly string[]>> = {
  AL: ['revenue.alabama.gov', 'alison.legislature.state.al.us'],
  AK: ['tax.alaska.gov', 'akleg.gov'],
  AZ: ['azdor.gov', 'azleg.gov'],
  AR: ['dfa.arkansas.gov', 'arkleg.state.ar.us'],
  CA: ['ftb.ca.gov', 'leginfo.legislature.ca.gov'],
  CO: ['tax.colorado.gov', 'leg.colorado.gov'],
  CT: ['portal.ct.gov', 'cga.ct.gov'],
  DE: ['revenue.delaware.gov', 'delcode.delaware.gov'],
  DC: ['otr.dc.gov', 'code.dccouncil.gov'],
  FL: ['floridarevenue.com', 'leg.state.fl.us', 'flsenate.gov'],
  GA: ['dor.georgia.gov', 'legis.ga.gov'],
  HI: ['tax.hawaii.gov', 'capitol.hawaii.gov'],
  ID: ['tax.idaho.gov', 'legislature.idaho.gov'],
  IL: ['tax.illinois.gov', 'ilga.gov'],
  IN: ['in.gov', 'iga.in.gov'],
  IA: ['revenue.iowa.gov', 'legis.iowa.gov'],
  KS: ['ksrevenue.gov', 'kslegislature.gov', 'ksrevisor.org'],
  KY: ['revenue.ky.gov', 'legislature.ky.gov'],
  LA: ['revenue.louisiana.gov', 'legis.la.gov'],
  ME: ['maine.gov', 'legislature.maine.gov'],
  MD: ['marylandtaxes.gov', 'mgaleg.maryland.gov'],
  MA: ['mass.gov', 'malegislature.gov'],
  MI: ['michigan.gov', 'legislature.mi.gov'],
  MN: ['revenue.state.mn.us', 'revisor.mn.gov'],
  MS: ['dor.ms.gov', 'legislature.ms.gov'],
  MO: ['dor.mo.gov', 'revisor.mo.gov'],
  MT: ['mtrevenue.gov', 'leg.mt.gov'],
  NE: ['revenue.nebraska.gov', 'nebraskalegislature.gov'],
  NV: ['tax.nv.gov', 'leg.state.nv.us'],
  NH: ['revenue.nh.gov', 'gc.nh.gov', 'gencourt.state.nh.us'],
  NJ: ['nj.gov', 'njleg.gov', 'njleg.state.nj.us'],
  NM: ['tax.newmexico.gov', 'nmlegis.gov'],
  NY: ['tax.ny.gov', 'nysenate.gov', 'public.leginfo.state.ny.us'],
  NC: ['ncdor.gov', 'ncleg.gov'],
  ND: ['tax.nd.gov', 'ndlegis.gov'],
  OH: ['tax.ohio.gov', 'codes.ohio.gov'],
  OK: ['oklahoma.gov', 'oklegislature.gov'],
  OR: ['oregon.gov', 'oregonlegislature.gov'],
  PA: ['revenue.pa.gov', 'legis.state.pa.us', 'palegis.us'],
  RI: ['tax.ri.gov', 'rilegislature.gov'],
  SC: ['dor.sc.gov', 'scstatehouse.gov'],
  SD: ['dor.sd.gov', 'sdlegislature.gov'],
  TN: ['tn.gov', 'capitol.tn.gov'],
  TX: ['comptroller.texas.gov', 'statutes.capitol.texas.gov'],
  UT: ['tax.utah.gov', 'le.utah.gov'],
  VT: ['tax.vermont.gov', 'legislature.vermont.gov'],
  VA: ['tax.virginia.gov', 'law.lis.virginia.gov'],
  WA: ['dor.wa.gov', 'leg.wa.gov'],
  WV: ['tax.wv.gov', 'wvlegislature.gov'],
  WI: ['revenue.wi.gov', 'docs.legis.wisconsin.gov'],
  WY: ['revenue.wyo.gov', 'wyoleg.gov'],
};

/** Jurisdiction code of a federal parameter check. */
export const FEDERAL_JURISDICTION = 'US';

/** Domains an AI check for `jurisdiction` may use: federal list, plus the state's own for a state rule. */
export function allowedDomainsFor(jurisdiction: string): string[] {
  if (jurisdiction === FEDERAL_JURISDICTION) return [...FEDERAL_TRUSTED_DOMAINS];
  const st = STATE_TRUSTED_DOMAINS[jurisdiction as StateCode];
  if (!st) throw new Error(`No trusted domains for jurisdiction '${jurisdiction}'`);
  return [...FEDERAL_TRUSTED_DOMAINS, ...st];
}

/** Lower-case hostname of an http(s) URL, or null when it does not parse / is not http(s). */
export function urlHost(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

/** True when `url`'s host is one of `domains` or a subdomain of one. */
export function isUrlAllowed(url: string, domains: readonly string[]): boolean {
  const host = urlHost(url);
  if (!host) return false;
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}
