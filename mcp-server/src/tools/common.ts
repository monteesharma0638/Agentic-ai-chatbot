import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Fund, FundRepository } from '../data/repository.js';

export interface ToolDeps {
  server: McpServer;
  repo: FundRepository;
}

export const DATA_SOURCE = 'AMFI India NAV data via amfiindia.com & mfapi.in';

export const schemeCodeArg = z
  .number()
  .int()
  .positive()
  .describe('AMFI scheme code from search_funds, e.g. 122639');

export const fundNameArg = z
  .string()
  .min(2)
  .describe(
    'Fund name, used instead of scheme_code (saves a search_funds call), e.g. "parag parikh flexi cap". ' +
      'Direct-Growth is chosen unless the name says Regular or IDCW; the matched scheme is returned.',
  );

/** Every single-fund tool accepts either a scheme code or a fund name. */
export const fundArgs = {
  scheme_code: schemeCodeArg.optional(),
  fund: fundNameArg.optional(),
};

export const dateArg = (what: string) => z.string().describe(`${what}, format YYYY-MM-DD`);

/** Resolves a fund name to its best-matching scheme (Direct-Growth preferred). */
export async function resolveFundName(repo: FundRepository, name: string): Promise<{ code: number; others: string[] }> {
  const hits = await repo.search(name, {}, 3);
  if (!hits.length) throw new Error(`No fund matches "${name}". Try search_funds with fewer or different words.`);
  return { code: hits[0].scheme_code, others: hits.slice(1).map((h) => h.scheme_name) };
}

/** Loads a fund from `scheme_code` or `fund` (name). */
export async function loadFund(repo: FundRepository, args: { scheme_code?: number; fund?: string }): Promise<Fund> {
  if (args.scheme_code) return repo.getFund(args.scheme_code);
  if (!args.fund) throw new Error('Provide scheme_code or fund (a fund name).');
  const { code, others } = await resolveFundName(repo, args.fund);
  return { ...(await repo.getFund(code)), matchedFrom: { query: args.fund, other_matches: others } };
}

export const READ_ONLY = { readOnlyHint: true, openWorldHint: true, idempotentHint: true } as const;

function toResult(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

/**
 * Wraps a tool body so thrown errors become `isError` results the model can
 * read and recover from (e.g. retry with a corrected scheme code).
 */
export async function run(body: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return toResult(await body());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[tool] error:', message);
    return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
  }
}

export function fundHeader(fund: Fund) {
  return {
    scheme_code: fund.code,
    scheme_name: fund.name,
    fund_house: fund.fundHouse,
    category: fund.category,
    // Lets the model tell the user which scheme a name resolved to, or ask if it looks wrong.
    ...(fund.matchedFrom && { matched_from_name: fund.matchedFrom }),
  };
}

/** Maps AMFI categories to broad asset classes for allocation views. */
export function assetClass(category: string, name = ''): string {
  const text = `${category} ${name}`;
  if (/gold|silver/i.test(text)) return 'Commodities';
  if (/hybrid|balanced|arbitrage|asset allocation|equity savings/i.test(category)) return 'Hybrid';
  if (/debt|income|liquid|money market|gilt|overnight|duration|bond|credit risk|floating|floater/i.test(category)) return 'Debt';
  if (/fund of funds|fof/i.test(category)) return /overseas|international|global/i.test(text) ? 'International' : 'Fund of Funds';
  if (/equity|elss|index|etf|cap|thematic|sectoral|contra|value|focused|dividend yield/i.test(category)) return 'Equity';
  return 'Other';
}
