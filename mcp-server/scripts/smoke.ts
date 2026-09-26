/**
 * End-to-end smoke test: spawns the MCP server over stdio and calls every
 * tool against live AMFI / mfapi.in data.  Run: npm run smoke -w mcp-server
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'smoke-test', version: '1.0.0' });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/index.ts', '--stdio'] }),
);

const { tools } = await client.listTools();
console.log(`tools (${tools.length}): ${tools.map((t) => t.name).join(', ')}\n`);

const calls: [string, Record<string, unknown>][] = [
  ['search_funds', { query: 'parag parikh flexi cap', limit: 3 }],
  ['list_categories', {}],
  ['list_fund_houses', {}],
  ['get_fund_overview', { scheme_code: 122639 }],
  ['get_nav_history', { scheme_code: 122639, from_date: '2024-01-01' }],
  ['get_nav_on_date', { scheme_code: 122639, dates: ['2020-03-23', '2025-01-01'] }],
  ['calculate_lumpsum_returns', { scheme_code: 122639, amount: 100000, start_date: '2020-03-23' }],
  ['calculate_sip_returns', { scheme_code: 122639, monthly_amount: 10000, start_date: '2019-01-01', annual_step_up_pct: 10 }],
  ['estimate_future_value', { scheme_code: 122639, years: 10, monthly_sip: 10000 }],
  ['get_rolling_returns', { scheme_code: 122639, window_years: 5 }],
  ['get_risk_metrics', { scheme_code: 122639, period_years: 5 }],
  ['compare_funds', { scheme_codes: [122639, 120716] }],
  ['rank_funds_in_category', { category: 'small cap', period: '3Y', limit: 5 }],
  ['analyze_portfolio', { holdings: [{ scheme_code: 122639, units: 250.5, invested_amount: 15000 }, { scheme_code: 120716, units: 100, transactions: [{ date: '2022-01-10', amount: 12000 }] }] }],
  // Name-based lookups (no search_funds round trip).
  ['get_nav_on_date', { fund: 'parag parikh flexi cap', dates: ['2020-03-23'] }],
  ['calculate_sip_returns', { fund: 'hdfc mid cap', monthly_amount: 10000, start_date: '2019-01-01' }],
  ['compare_funds', { funds: ['sbi small cap', 'nippon india small cap'] }],
  ['get_risk_metrics', { fund: 'uti nifty 50 index regular' }],
  ['get_nav_on_date', { scheme_code: 999999999, dates: ['2024-01-01'] }], // expected error
];

let failures = 0;
for (const [name, args] of calls) {
  const started = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0]?.text ?? '';
  const ms = Date.now() - started;
  const expectedError = name === 'get_nav_on_date' && (args.scheme_code as number) > 1e8;
  const ok = expectedError ? res.isError : !res.isError;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (${ms} ms, ${text.length} chars)`);
  console.log(`  ${text.slice(0, 600)}${text.length > 600 ? ' …' : ''}\n`);
}

await client.close();
console.log(failures ? `${failures} failure(s)` : 'All tools OK');
process.exit(failures ? 1 : 0);
