import { config } from '../config.js';
import { amfiDateToIso } from '../lib/dates.js';
import { httpGet } from '../lib/http.js';
import { normalizeText, tokenize } from './search.js';

export interface SchemeRecord {
  code: number;
  /** Full display name, e.g. "Parag Parikh Flexi Cap Fund - Direct Plan - Growth". */
  name: string;
  plan: 'Direct' | 'Regular' | null;
  option: string | null;
  isGrowth: boolean;
  /** Normalised category, e.g. "Equity Scheme - Flexi Cap Fund". */
  category: string;
  schemeType: string; // Open Ended Schemes / Close Ended Schemes / Interval Fund Schemes
  fundHouse: string;
  isinGrowth: string | null;
  isinReinvestment: string | null;
  nav: number | null;
  navDate: string | null; // ISO
  /** Pre-computed search tokens (name + fund house). */
  tokens: string[];
  tokenSet: Set<string>;
  normalizedCategory: string;
}

export interface Directory {
  schemes: SchemeRecord[];
  byCode: Map<number, SchemeRecord>;
  loadedAt: string;
}

const SECTION_RE = /^(Open Ended Schemes|Close Ended Schemes|Interval Fund Schemes)\s*\((.*)\)\s*$/;

export function normalizeCategory(raw: string): string {
  return raw
    .replace(/\*+/g, '')
    .replace(/\bSchemes\b/g, 'Scheme')
    .replace(/’/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/\s+-\s+/g, ' - ')
    .trim();
}

function clean(value: string | undefined): string | null {
  const v = value?.trim();
  return !v || v === '-' || /^n\.?a\.?$/i.test(v) ? null : v;
}

function normalizePlan(plan: string | null, name: string): 'Direct' | 'Regular' | null {
  const source = plan ?? name;
  if (/direct/i.test(source)) return 'Direct';
  if (/regular/i.test(source)) return 'Regular';
  return null;
}

/**
 * Parses AMFI's NAVAll.txt. The file interleaves section headers
 * ("Open Ended Schemes(Equity Scheme - Large Cap Fund)"), fund-house lines and
 * `;`-separated scheme rows. Column positions are taken from the header row so
 * both the legacy 6-column and the newer 8-column (Plan/Option) layouts work.
 */
export function parseNavAll(text: string): SchemeRecord[] {
  const lines = text.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => l.startsWith('Scheme Code'));
  if (headerIdx < 0) throw new Error('Unexpected AMFI NAV file format (header not found)');
  const header = lines[headerIdx].split(';').map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.findIndex((h) => h === name);
  const idx = {
    code: 0,
    isinGrowth: 1,
    isinReinvest: 2,
    name: col('scheme name'),
    plan: col('plan'),
    option: col('option'),
    nav: col('net asset value'),
    date: col('date'),
  };

  const schemes: SchemeRecord[] = [];
  let schemeType = '';
  let category = '';
  let fundHouse = '';

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (!line.includes(';')) {
      const section = SECTION_RE.exec(line);
      if (section) {
        schemeType = section[1];
        category = normalizeCategory(section[2]);
      } else {
        fundHouse = line;
      }
      continue;
    }
    const cols = line.split(';');
    const code = Number(cols[idx.code]);
    const baseName = cols[idx.name]?.trim();
    if (!Number.isInteger(code) || !baseName) continue;

    const planRaw = idx.plan >= 0 ? clean(cols[idx.plan]) : null;
    const optionRaw = idx.option >= 0 ? clean(cols[idx.option]) : null;
    const parts = [baseName];
    if (planRaw && !baseName.toLowerCase().includes(planRaw.toLowerCase())) parts.push(planRaw);
    if (optionRaw && !baseName.toLowerCase().includes(optionRaw.toLowerCase())) parts.push(optionRaw);
    const name = parts.join(' - ');
    const optionText = optionRaw ?? name;
    const navValue = Number(cols[idx.nav]);
    const tokens = tokenize(`${name} ${fundHouse.replace(/mutual fund/i, '')}`);

    schemes.push({
      code,
      name,
      plan: normalizePlan(planRaw, name),
      option: optionRaw,
      isGrowth: /growth/i.test(optionText) && !/idcw|dividend|bonus/i.test(optionText),
      category,
      schemeType,
      fundHouse,
      isinGrowth: clean(cols[idx.isinGrowth]),
      isinReinvestment: clean(cols[idx.isinReinvest]),
      nav: Number.isFinite(navValue) && navValue > 0 ? navValue : null,
      navDate: amfiDateToIso(cols[idx.date] ?? ''),
      tokens,
      tokenSet: new Set(tokens),
      normalizedCategory: normalizeText(category),
    });
  }
  return schemes;
}

/**
 * The AMFI master list of currently active schemes with their latest NAV.
 * Refreshed every few hours; if a refresh fails the last good copy keeps serving.
 */
export class AmfiDirectory {
  private current: Directory | null = null;
  private expiresAt = 0;
  private loading: Promise<Directory> | null = null;

  async get(): Promise<Directory> {
    if (this.current && Date.now() < this.expiresAt) return this.current;
    if (!this.loading) {
      this.loading = this.refresh().finally(() => {
        this.loading = null;
      });
    }
    if (this.current) {
      // Stale-while-revalidate: serve old data, refresh in background.
      this.loading.catch((err) => console.error('[amfi] background refresh failed:', err.message));
      return this.current;
    }
    return this.loading;
  }

  private async refresh(): Promise<Directory> {
    const res = await httpGet(config.amfiNavUrl);
    const schemes = parseNavAll(await res.text());
    if (schemes.length < 1000) throw new Error(`AMFI NAV file looks truncated (${schemes.length} schemes)`);
    this.current = {
      schemes,
      byCode: new Map(schemes.map((s) => [s.code, s])),
      loadedAt: new Date().toISOString(),
    };
    this.expiresAt = Date.now() + config.directoryTtlMs;
    console.error(`[amfi] loaded ${schemes.length} schemes`);
    return this.current;
  }
}
