import { z } from 'zod';
import { READ_ONLY, run, type ToolDeps } from './common.js';

export function registerDiscoveryTools({ server, repo }: ToolDeps): void {
  server.registerTool(
    'search_funds',
    {
      title: 'Search mutual funds',
      description:
        'Find Indian mutual fund schemes by name, AMC or keywords and get their scheme codes (required by every other tool). ' +
        "Fuzzy matching, e.g. 'parag parikh flexi cap', 'hdfc mid cap direct growth', 'sbi small cap', 'nifty 50 index'. " +
        'Returns category, plan (Direct/Regular), latest NAV and NAV date. Each fund has separate Direct/Regular and Growth/IDCW schemes; ' +
        'prefer Direct + Growth unless the user says otherwise.',
      inputSchema: {
        query: z.string().min(2).describe('Fund name or keywords'),
        plan: z.enum(['direct', 'regular']).optional().describe('Restrict to Direct or Regular plans'),
        option: z.enum(['growth', 'idcw']).optional().describe('Restrict to Growth or IDCW (dividend) options'),
        category: z.string().optional().describe("Category filter, e.g. 'small cap', 'elss', 'liquid', 'flexi cap'"),
        fund_house: z.string().optional().describe("AMC filter, e.g. 'HDFC', 'SBI', 'ICICI Prudential'"),
        limit: z.number().int().min(1).max(25).optional().describe('Max results (default 8)'),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const results = await repo.search(
          args.query,
          { plan: args.plan, option: args.option, category: args.category, fundHouse: args.fund_house },
          args.limit ?? 8,
        );
        return {
          query: args.query,
          count: results.length,
          results,
          ...(results.length === 0 && {
            hint: 'No match. Try fewer words, a different spelling, or remove filters.',
          }),
        };
      }),
  );

  server.registerTool(
    'list_categories',
    {
      title: 'List fund categories',
      description:
        'List SEBI/AMFI mutual fund categories (e.g. "Equity Scheme - Small Cap Fund") with the number of schemes in each. ' +
        'Use it to find the exact category name for rank_funds_in_category.',
      inputSchema: {
        include_closed_ended: z.boolean().optional().describe('Include close-ended and interval schemes (default false)'),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const dir = await repo.directory.get();
        const counts = new Map<string, number>();
        for (const s of dir.schemes) {
          if (!args.include_closed_ended && !s.schemeType.startsWith('Open Ended')) continue;
          counts.set(s.category, (counts.get(s.category) ?? 0) + 1);
        }
        return {
          categories: [...counts.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([category, schemes]) => ({ category, schemes })),
        };
      }),
  );

  server.registerTool(
    'list_fund_houses',
    {
      title: 'List AMCs',
      description: 'List all Asset Management Companies (fund houses) in India with their number of active schemes.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      run(async () => {
        const dir = await repo.directory.get();
        const counts = new Map<string, number>();
        for (const s of dir.schemes) counts.set(s.fundHouse, (counts.get(s.fundHouse) ?? 0) + 1);
        return {
          fund_houses: [...counts.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([fund_house, schemes]) => ({ fund_house, schemes })),
        };
      }),
  );
}
