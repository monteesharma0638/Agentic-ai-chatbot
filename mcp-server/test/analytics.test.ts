import { describe, expect, it } from 'vitest';
import { projectCorpus, simulateLumpsum, simulateSip, xirr } from '../src/analytics/investments.js';
import { cagr, calendarYearReturns, rollingReturns, trailingReturns } from '../src/analytics/returns.js';
import { maxDrawdown, riskMetrics } from '../src/analytics/risk.js';
import { parseNavAll } from '../src/data/amfi.js';
import { NavSeries } from '../src/data/navSeries.js';
import { searchSchemes } from '../src/data/search.js';
import { addMonths, dayToIso, isoToDay, parseDateArg } from '../src/lib/dates.js';
import { downsample } from '../src/tools/nav.js';

/** Business-day series growing at a constant annual rate. */
function growthSeries(from: string, to: string, annual: number, start = 100): NavSeries {
  const points = [];
  const d0 = isoToDay(from);
  for (let d = d0; d <= isoToDay(to); d++) {
    const weekday = new Date(d * 86_400_000).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    points.push({ date: dayToIso(d), nav: start * (1 + annual) ** ((d - d0) / 365) });
  }
  return new NavSeries(points);
}

describe('dates', () => {
  it('clamps month arithmetic', () => {
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2023-03-31', -1)).toBe('2023-02-28');
    expect(addMonths('2024-12-15', 1)).toBe('2025-01-15');
  });
  it('parses user dates', () => {
    expect(parseDateArg('2024-3-5')).toBe('2024-03-05');
    expect(parseDateArg('05/03/2024')).toBe('2024-03-05');
    expect(() => parseDateArg('2024-02-30')).toThrow(/Invalid/);
  });
});

describe('NavSeries', () => {
  const s = new NavSeries([
    { date: '2024-01-03', nav: 12 },
    { date: '2024-01-01', nav: 10 },
    { date: '2024-01-02', nav: 11 },
  ]);
  it('sorts and snaps lookups to business days', () => {
    expect(s.first()).toEqual({ date: '2024-01-01', nav: 10 });
    expect(s.onOrBefore('2024-01-10')?.nav).toBe(12);
    expect(s.onOrAfter('2023-12-25')?.nav).toBe(10);
    expect(s.onOrBefore('2023-12-31')).toBeNull();
  });
});

describe('returns', () => {
  it('computes CAGR', () => {
    expect(cagr(100, 200, 5)).toBeCloseTo(0.1487, 4);
    expect(cagr(0, 200, 5)).toBeNull();
  });

  it('trailing returns follow a constant growth rate', () => {
    const s = growthSeries('2015-01-01', '2025-06-30', 0.12);
    const t = trailingReturns(s);
    expect(t['3Y']!.annualised!).toBeCloseTo(0.12, 2);
    expect(t['5Y']!.annualised!).toBeCloseTo(0.12, 2);
    expect(t['1M']!.annualised).toBeNull(); // < 1 year → absolute only
    expect(t['1M']!.absolute).toBeGreaterThan(0);
    expect(trailingReturns(growthSeries('2024-01-01', '2025-06-30', 0.1))['3Y']).toBeNull();
  });

  it('rolling returns of a constant-growth series are tight around the rate', () => {
    const d = rollingReturns(growthSeries('2015-01-01', '2025-06-30', 0.1), 3)!;
    expect(d.median).toBeCloseTo(0.1, 2);
    expect(d.p10).toBeCloseTo(0.1, 2);
    expect(d.negativeShare).toBe(0);
  });

  it('calendar-year returns flag partial years', () => {
    const years = calendarYearReturns(growthSeries('2020-06-01', '2023-03-31', 0.1));
    expect(years.map((y) => y.year)).toEqual([2020, 2021, 2022, 2023]);
    expect(years[0].partial).toBe(true);
    expect(years[1].partial).toBe(false);
    expect(years[1].return).toBeCloseTo(0.1, 2);
    expect(years[3].partial).toBe(true);
  });
});

describe('investments', () => {
  it('xirr matches a known lumpsum', () => {
    const r = xirr([
      { day: isoToDay('2020-01-01'), amount: -10000 },
      { day: isoToDay('2023-01-01'), amount: 13310 },
    ]);
    expect(r!).toBeCloseTo(0.0999, 3);
  });

  it('xirr returns null without a sign change', () => {
    expect(xirr([{ day: 0, amount: -1 }, { day: 10, amount: -1 }])).toBeNull();
  });

  it('SIP XIRR equals the underlying growth rate', () => {
    const s = growthSeries('2018-01-01', '2025-01-01', 0.12);
    const r = simulateSip(s, { monthlyAmount: 5000, startIso: '2019-01-05', endIso: '2024-12-31' });
    expect(r.instalments).toBe(72);
    expect(r.invested).toBe(360000);
    expect(r.xirr!).toBeCloseTo(0.12, 2);
    expect(r.snapshots.at(-1)!.value).toBeCloseTo(r.value, 6);
  });

  it('SIP step-up raises the amount every 12 instalments', () => {
    const s = growthSeries('2018-01-01', '2025-01-01', 0.1);
    const r = simulateSip(s, { monthlyAmount: 1000, startIso: '2020-01-10', endIso: '2021-12-31', stepUpPct: 10 });
    expect(r.instalments).toBe(24);
    expect(r.invested).toBeCloseTo(12 * 1000 + 12 * 1100, 6);
  });

  it('lumpsum clamps to inception', () => {
    const s = growthSeries('2020-01-01', '2024-01-01', 0.1);
    const r = simulateLumpsum(s, 10000, '2015-01-01');
    expect(r.startAdjusted).toBe(true);
    expect(r.annualised!).toBeCloseTo(0.1, 2);
  });

  it('projects a SIP corpus', () => {
    // ₹10,000/month for 10 years at 12% ≈ ₹23 lakh (annuity due, monthly compounding).
    const p = projectCorpus({ lumpsum: 0, monthlySip: 10000, years: 10, annualReturn: 0.12, inflationPct: 6 });
    expect(p.invested).toBe(1_200_000);
    expect(p.futureValue).toBeGreaterThan(2_200_000);
    expect(p.futureValue).toBeLessThan(2_350_000);
    expect(p.realValue!).toBeLessThan(p.futureValue);
  });
});

describe('risk', () => {
  it('finds max drawdown and recovery', () => {
    const s = new NavSeries(
      [100, 120, 90, 60, 80, 125, 110].map((nav, i) => ({ date: dayToIso(isoToDay('2024-01-01') + i), nav })),
    );
    const dd = maxDrawdown(s);
    expect(dd.depth).toBeCloseTo(-0.5, 6);
    expect(dd.peakDate).toBe('2024-01-02');
    expect(dd.troughDate).toBe('2024-01-04');
    expect(dd.recoveryDate).toBe('2024-01-06');
  });

  it('beta vs itself is 1', () => {
    const s = growthSeries('2021-01-01', '2024-01-01', 0.1);
    const wobble = new NavSeries(
      Array.from({ length: s.length }, (_, i) => ({ date: s.point(i).date, nav: s.navs[i] * (1 + 0.01 * Math.sin(i)) })),
    );
    const r = riskMetrics(wobble, 0.065, wobble)!;
    expect(r.benchmark!.beta).toBeCloseTo(1, 6);
    expect(r.benchmark!.correlation).toBeCloseTo(1, 6);
    expect(r.volatility).toBeGreaterThan(0);
  });
});

describe('AMFI parsing and search', () => {
  const sample = [
    'Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date',
    ' ',
    'Open Ended Schemes(Equity Scheme - Flexi Cap Fund)',
    ' ',
    'PPFAS Mutual Fund',
    ' ',
    '122639;INF879O01027;-;Parag Parikh Flexi Cap Fund;Direct Plan;Growth;89.6034;24-Sep-2026',
    '153964;-;INF879O01308;Parag Parikh Flexi Cap Fund;Direct Plan;Monthly IDCW Payout;89.6034;24-Sep-2026',
    '122640;INF879O01019;-;Parag Parikh Flexi Cap Fund;Regular Plan;Growth;81.6129;24-Sep-2026',
    ' ',
    'Open Ended Schemes(Equity Schemes - Mid Cap Fund)',
    ' ',
    'HDFC Mutual Fund',
    ' ',
    '118989;INF179K01XQ0;-;HDFC Mid-Cap Opportunities Fund;Direct Plan;Growth Option;210.1;24-Sep-2026',
    '118990;-;-;HDFC Mid-Cap Opportunities Fund;Direct Plan;IDCW Option;N.A.;24-Sep-2026',
  ].join('\n');
  const schemes = parseNavAll(sample);

  it('parses sections, fund houses and plan/option columns', () => {
    expect(schemes).toHaveLength(5);
    const ppfas = schemes[0];
    expect(ppfas.name).toBe('Parag Parikh Flexi Cap Fund - Direct Plan - Growth');
    expect(ppfas.fundHouse).toBe('PPFAS Mutual Fund');
    expect(ppfas.category).toBe('Equity Scheme - Flexi Cap Fund');
    expect(ppfas.plan).toBe('Direct');
    expect(ppfas.isGrowth).toBe(true);
    expect(ppfas.navDate).toBe('2026-09-24');
    expect(schemes[1].isGrowth).toBe(false);
    expect(schemes[3].category).toBe('Equity Scheme - Mid Cap Fund');
    expect(schemes[4].nav).toBeNull();
  });

  it('fuzzy search prefers Direct Growth and handles spelling variants', () => {
    expect(searchSchemes(schemes, 'parag parikh flexi', {}, 3)[0].scheme.code).toBe(122639);
    expect(searchSchemes(schemes, 'ppfas flexicap regular', {}, 3)[0].scheme.code).toBe(122640);
    expect(searchSchemes(schemes, 'hdfc midcap', {}, 3)[0].scheme.code).toBe(118989);
    expect(searchSchemes(schemes, 'parag parik', {}, 3)[0].scheme.code).toBe(122639);
    expect(searchSchemes(schemes, 'quant small cap', {}, 3)).toHaveLength(0);
    expect(searchSchemes(schemes, 'fund', { category: 'mid cap' }, 5).map((h) => h.scheme.code)).toEqual([118989, 118990]);
  });
});

describe('downsample', () => {
  it('keeps month-end points and the last point', () => {
    const s = growthSeries('2024-01-01', '2024-06-15', 0.1);
    const pts = downsample(s, 'monthly', 100);
    expect(pts).toHaveLength(6);
    expect(pts[0][0]).toBe('2024-01-31');
    expect(pts.at(-1)![0]).toBe('2024-06-14');
  });
  it('thins to max points', () => {
    const s = growthSeries('2020-01-01', '2024-01-01', 0.1);
    expect(downsample(s, 'daily', 50)).toHaveLength(50);
  });
});
