import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FundRepository } from './data/repository.js';
import { registerAnalysisTools } from './tools/analysis.js';
import { registerCalculatorTools } from './tools/calculators.js';
import { registerDiscoveryTools } from './tools/discovery.js';
import { registerNavTools } from './tools/nav.js';
import { registerPortfolioTools } from './tools/portfolio.js';

/** Shared across MCP sessions so caches are reused by every client. */
export const repository = new FundRepository();

export function createMfServer(): McpServer {
  const server = new McpServer(
    { name: 'india-mutual-funds', version: '1.0.0' },
    {
      instructions:
        'Indian mutual fund data (AMFI). Fund tools accept a scheme_code or a fund name (`fund`, Direct-Growth preferred); ' +
          'use search_funds to browse or disambiguate. ' +
        'Dates are YYYY-MM-DD. Returns >= 1 year are CAGR; SIP returns are XIRR. All amounts are INR.',
    },
  );
  const deps = { server, repo: repository };
  registerDiscoveryTools(deps);
  registerNavTools(deps);
  registerCalculatorTools(deps);
  registerAnalysisTools(deps);
  registerPortfolioTools(deps);
  return server;
}
