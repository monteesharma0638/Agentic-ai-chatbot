import { z } from 'zod';
import { calendarYearReturns, trailingReturns } from '../analytics/returns.js';
import { riskMetrics } from '../analytics/risk.js';
import { config } from '../config.js';
import { NavSeries } from '../data/navSeries.js';
import { addYears, dayToIso, isoToDay, parseDateArg, todayIst } from '../lib/dates.js';
import { pct, round } from '../lib/format.js';
import { DATA_SOURCE, dateArg, fundArgs, fundHeader, loadFund, READ_ONLY, run, type ToolDeps } from './common.js';

type Interval = 'daily' | 'weekly' | 'monthly';

/** Keeps the last NAV of each week/month bucket, then thins evenly to `maxPoints`. */
export function downsample(series: NavSeries, interval: Interval, maxPoints: number): [string, number][] {
  const out: [string, number][] = [];
  for (let i = 0; i < series.length; i++) {
    const isLast = i === series.length - 1;
    if (interval !== 'daily' && !isLast) {
      const cur = series.days[i];
      const next = series.days[i + 1];
      // Week buckets: days since epoch shifted so weeks start on Monday (epoch day 0 was a Thursday).
      const sameBucket =
        interval === 'weekly'
          ? Math.floor((cur + 3) / 7) === Math.floor((next + 3) / 7)
          : dayToIso(cur).slice(0, 7) === dayToIso(next).slice(0, 7);
      if (sameBucket) continue;
    }
    out.push([dayToIso(series.days[i]), series.navs[i]]);
  }
  if (out.length <= maxPoints) return out;
  const step = (out.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, k) => out[Math.round(k * step)]);
}

function autoInterval(tradingDays: number): Interval {
  if (tradingDays <= 130) return 'daily';
  if (tradingDays <= 700) return 'weekly';
  return 'monthly';
}

export function registerNavTools({ server, repo }: ToolDeps): void {
  server.registerTool(
    'get_fund_overview',
    {
      title: 'Fund overview',
      description:
        'Snapshot of one scheme: AMC, category, latest NAV (with date and 1-day change), 52-week high/low, inception date, ' +
        'trailing returns (1W..10Y and since inception; periods >= 1Y are CAGR), calendar-year returns and 3-year risk. ' +
        'Use this first for "how is fund X doing" questions.',
      inputSchema: fundArgs,
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const fund = await loadFund(repo, args);
        const s = fund.series;
        const latest = s.last();
        const prev = s.length > 1 ? s.point(s.length - 2) : null;
        const yearAgo = isoToDay(addYears(latest.date, -1));
        const lastYear = s.slice(yearAgo, s.lastDay);
        let hi = 0;
        let lo = 0;
        for (let i = 1; i < lastYear.length; i++) {
          if (lastYear.navs[i] > lastYear.navs[hi]) hi = i;
          if (lastYear.navs[i] < lastYear.navs[lo]) lo = i;
        }
        const trailing = trailingReturns(s);
        const risk = riskMetrics(s.slice(isoToDay(addYears(latest.date, -3)), s.lastDay), config.riskFreeRatePct / 100);
        const staleDays = isoToDay(todayIst()) - s.lastDay;

        return {
          ...fundHeader(fund),
          plan: fund.plan,
          scheme_type: fund.schemeType,
          isin: fund.isin,
          latest_nav: { date: latest.date, nav: latest.nav },
          day_change_pct: prev ? pct(latest.nav / prev.nav - 1) : null,
          inception: { first_nav_date: s.first().date, first_nav: s.first().nav },
          week52: lastYear.isEmpty
            ? null
            : { high: lastYear.point(hi), low: lastYear.point(lo) },
          trailing_returns_pct: Object.fromEntries(
            Object.entries(trailing).map(([k, v]) => [k, v ? pct(v.annualised ?? v.absolute) : null]),
          ),
          calendar_year_returns_pct: calendarYearReturns(s)
            .slice(-6)
            .map((c) => ({ year: c.year, return_pct: pct(c.return), ...(c.partial && { partial: true }) })),
          risk_3y: risk && {
            period: `${risk.from} to ${risk.to}`,
            volatility_pct: pct(risk.volatility),
            max_drawdown_pct: pct(risk.maxDrawdown.depth),
            sharpe: risk.sharpe === null ? null : round(risk.sharpe),
          },
          notes: [
            'trailing_returns_pct: periods under 1 year are absolute, 1 year and above are CAGR. null = fund too young.',
            ...(staleDays > 7 ? [`Latest NAV is ${staleDays} days old; the scheme may be closed, merged or matured.`] : []),
          ],
          source: DATA_SOURCE,
        };
      }),
  );

  server.registerTool(
    'get_nav_history',
    {
      title: 'NAV history',
      description:
        'Historical NAV series for a scheme between two dates (default: last 1 year), down-sampled for charting, ' +
        'plus period change, high and low. The app renders these points as a chart automatically, so do not list them in the reply.',
      inputSchema: {
        ...fundArgs,
        from_date: dateArg('Start date (default 1 year ago)').optional(),
        to_date: dateArg('End date (default latest)').optional(),
        interval: z.enum(['auto', 'daily', 'weekly', 'monthly']).optional().describe('Sampling interval (default auto)'),
        max_points: z.number().int().min(10).max(500).optional().describe('Max points returned (default 120)'),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const fund = await loadFund(repo, args);
        const s = fund.series;
        const toIso = args.to_date ? parseDateArg(args.to_date, 'to_date') : s.last().date;
        const fromIso = args.from_date ? parseDateArg(args.from_date, 'from_date') : addYears(toIso, -1);
        const window = s.slice(isoToDay(fromIso), isoToDay(toIso));
        if (window.length < 2) {
          throw new Error(
            `Not enough NAV data between ${fromIso} and ${toIso}. Available range: ${s.first().date} to ${s.last().date}.`,
          );
        }
        const interval = !args.interval || args.interval === 'auto' ? autoInterval(window.length) : args.interval;
        let hi = 0;
        let lo = 0;
        for (let i = 1; i < window.length; i++) {
          if (window.navs[i] > window.navs[hi]) hi = i;
          if (window.navs[i] < window.navs[lo]) lo = i;
        }
        const first = window.first();
        const last = window.last();
        return {
          ...fundHeader(fund),
          from: first.date,
          to: last.date,
          interval,
          summary: {
            start_nav: first.nav,
            end_nav: last.nav,
            change_pct: pct(last.nav / first.nav - 1),
            high: window.point(hi),
            low: window.point(lo),
            ...(isoToDay(fromIso) < s.firstDay && { note: `Fund data starts on ${s.first().date}.` }),
          },
          points: downsample(window, interval, args.max_points ?? 120),
        };
      }),
  );

  server.registerTool(
    'get_nav_on_date',
    {
      title: 'NAV on specific dates',
      description:
        'Historical NAV of a scheme on one or more specific dates, and the % change from each date to the latest NAV. ' +
        'If a date is a weekend/holiday the previous business day NAV is used and flagged.',
      inputSchema: {
        ...fundArgs,
        dates: z.array(dateArg('Date')).min(1).max(12).describe('Dates to look up (YYYY-MM-DD)'),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const fund = await loadFund(repo, args);
        const s = fund.series;
        const latest = s.last();
        const rows = args.dates.map((raw) => {
          const date = parseDateArg(raw);
          const p = s.onOrBefore(date);
          if (!p) {
            return { requested_date: date, nav: null, note: `Before the first available NAV (${s.first().date}).` };
          }
          return {
            requested_date: date,
            nav_date: p.date,
            nav: p.nav,
            change_to_latest_pct: pct(latest.nav / p.nav - 1),
            ...(p.date !== date && { note: 'No NAV on requested date; previous business day used.' }),
            ...(isoToDay(date) > s.lastDay && { note: 'Date is after the latest NAV; latest NAV shown.' }),
          };
        });
        return { ...fundHeader(fund), latest_nav: latest, results: rows };
      }),
  );
}
