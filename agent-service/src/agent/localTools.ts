import type { FunctionDeclaration } from '@google/genai';
import type { McpHub, ToolCallResult } from '../mcp/hub.js';
import type { PortfolioProvider } from '../portfolio/providers.js';
import type { ChatUser } from './types.js';

export interface LocalToolContext {
  hub: McpHub;
  user: ChatUser;
  portfolio: PortfolioProvider | null;
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface LocalTool {
  declaration: FunctionDeclaration;
  /** Only offered to the model when this returns true for the request. */
  enabled(ctx: LocalToolContext): boolean;
  execute(args: Record<string, unknown>, ctx: LocalToolContext): Promise<ToolCallResult>;
}

/**
 * Tools that live in the agent rather than the MCP server because they need
 * the verified identity of the caller (never an id chosen by the model).
 */
export const LOCAL_TOOLS: LocalTool[] = [
  {
    declaration: {
      name: 'get_my_portfolio',
      description:
        "Get the signed-in user's own mutual fund holdings from the app, valued at the latest NAV: per-fund value, gain, " +
        'weights, XIRR (when transaction history is available) and allocation by asset class, category and AMC.',
    },
    enabled: (ctx) => ctx.portfolio !== null && !ctx.user.guest,
    async execute(_args, ctx) {
      const holdings = await ctx.portfolio!.getHoldings(ctx.user.id);
      if (!holdings.length) {
        return { ok: true, data: { holdings: [], note: 'The user has no mutual fund holdings in the app.' }, text: '' };
      }
      return ctx.hub.callTool(
        'analyze_portfolio',
        {
          holdings: holdings.map((h) => ({
            scheme_code: h.scheme_code,
            units: h.units,
            ...(h.invested_amount !== undefined && { invested_amount: h.invested_amount }),
            ...(h.transactions?.length && { transactions: h.transactions }),
          })),
        },
        { signal: ctx.signal, timeoutMs: ctx.timeoutMs },
      );
    },
  },
];
