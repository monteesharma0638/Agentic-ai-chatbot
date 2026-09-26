import type { SchemeRecord } from './amfi.js';

/** Words that carry no signal when matching fund names. */
const STOPWORDS = new Set(['fund', 'funds', 'mutual', 'mf', 'scheme', 'the', 'of', 'a', 'an', 'plan', 'option', 'and', 'nav']);

/** Words the user types to pick a variant rather than a fund. */
const PREFERENCE_WORDS = new Set(['direct', 'regular', 'growth', 'idcw', 'payout', 'reinvestment']);

/** Canonical spellings, applied to both fund names and queries. */
const REWRITES: [RegExp, string][] = [
  [/\bmid\s?cap\b/g, 'mid cap'],
  [/\bsmall\s?cap\b/g, 'small cap'],
  [/\blarge\s?cap\b/g, 'large cap'],
  [/\bflexi\s?cap\b/g, 'flexi cap'],
  [/\bmulti\s?cap\b/g, 'multi cap'],
  [/\bmicro\s?cap\b/g, 'micro cap'],
  [/\btax\s?saver\b/g, 'elss'],
  [/\bppfas\b/g, 'parag parikh'],
  [/\bdividend\b/g, 'idcw'],
  [/\bnifty\s?50\b/g, 'nifty 50'],
];

export function normalizeText(s: string): string {
  let out = s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ');
  for (const [re, rep] of REWRITES) out = out.replace(re, rep);
  return out.replace(/\s+/g, ' ').trim();
}

export function tokenize(s: string): string[] {
  return [...new Set(normalizeText(s).split(' ').filter((t) => t && !STOPWORDS.has(t)))];
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function tokenScore(queryToken: string, scheme: SchemeRecord): number {
  if (scheme.tokenSet.has(queryToken)) return 1;
  let best = 0;
  for (const t of scheme.tokens) {
    if (queryToken.length >= 3 && t.startsWith(queryToken)) best = Math.max(best, 0.8);
    else if (queryToken.length >= 5 && editDistanceAtMostOne(queryToken, t)) best = Math.max(best, 0.6);
  }
  return best;
}

export interface SearchFilters {
  plan?: 'direct' | 'regular';
  option?: 'growth' | 'idcw';
  category?: string;
  fundHouse?: string;
  openEndedOnly?: boolean;
}

export interface SearchHit {
  scheme: SchemeRecord;
  score: number;
}

export function matchesFilters(s: SchemeRecord, f: SearchFilters): boolean {
  if (f.plan && s.plan?.toLowerCase() !== f.plan) return false;
  if (f.option === 'growth' && !s.isGrowth) return false;
  if (f.option === 'idcw' && s.isGrowth) return false;
  if (f.openEndedOnly && !s.schemeType.startsWith('Open Ended')) return false;
  if (f.category) {
    const wanted = normalizeText(f.category);
    if (!s.normalizedCategory.includes(wanted)) return false;
  }
  if (f.fundHouse) {
    const wanted = normalizeText(f.fundHouse.replace(/mutual fund/i, ''));
    if (!normalizeText(s.fundHouse).includes(wanted)) return false;
  }
  return true;
}

/**
 * Token-based fuzzy search tuned for how people type fund names
 * ("parag parikh flexi", "hdfc midcap direct", "sbi small cap").
 */
export function searchSchemes(
  schemes: readonly SchemeRecord[],
  query: string,
  filters: SearchFilters,
  limit: number,
): SearchHit[] {
  const all = tokenize(query);
  const words = all.filter((t) => !PREFERENCE_WORDS.has(t));
  const wantsDirect = all.includes('direct') || filters.plan === 'direct';
  const wantsRegular = all.includes('regular') || filters.plan === 'regular';
  const wantsIdcw = all.includes('idcw') || filters.option === 'idcw';

  const hits: SearchHit[] = [];
  for (const scheme of schemes) {
    if (!matchesFilters(scheme, filters)) continue;
    let score = 1;
    if (words.length) {
      let sum = 0;
      for (const w of words) sum += tokenScore(w, scheme);
      score = sum / words.length;
      if (score < 0.6) continue;
    }
    // Preferences nudge ordering; they never exclude results.
    if (wantsRegular ? scheme.plan === 'Regular' : scheme.plan === 'Direct') score += wantsDirect || wantsRegular ? 0.15 : 0.05;
    if (wantsIdcw ? !scheme.isGrowth : scheme.isGrowth) score += 0.05;
    if (scheme.schemeType.startsWith('Open Ended')) score += 0.03;
    if (scheme.nav === null) score -= 0.1;
    // Shorter names are usually the "main" scheme rather than a niche variant.
    score -= scheme.tokens.length * 0.002;
    hits.push({ scheme, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}
