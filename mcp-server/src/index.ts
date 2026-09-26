#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import './config.js';
import { startHttpServer } from './http.js';
import { createMfServer } from './server.js';

const mode = process.argv.includes('--http')
  ? 'http'
  : process.argv.includes('--stdio')
    ? 'stdio'
    : (process.env.MCP_TRANSPORT ?? 'stdio');

if (mode === 'http') {
  await startHttpServer();
} else {
  // stdout is the protocol channel in stdio mode — all logging goes to stderr.
  const server = createMfServer();
  await server.connect(new StdioServerTransport());
  console.error('[mcp] India MF MCP server running on stdio');
}
