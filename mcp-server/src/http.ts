import { timingSafeEqual } from 'node:crypto';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import { createMfServer, repository } from './server.js';

function authorized(header: string | undefined): boolean {
  if (!config.authToken) return true;
  const expected = Buffer.from(`Bearer ${config.authToken}`);
  const actual = Buffer.from(header ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Streamable HTTP transport in stateless mode: every POST gets a fresh
 * McpServer, which is cheap because data caches live in the shared repository.
 * Stateless servers scale horizontally behind any load balancer.
 */
export async function startHttpServer(): Promise<void> {
  const bindAddresses = config.allowedHosts?.filter((h) => h === '0.0.0.0' || h === '::');
  if (bindAddresses?.length) {
    console.error(
      `[mcp] WARNING: MCP_ALLOWED_HOSTS contains ${bindAddresses.join(', ')}. It must list hostnames clients connect with ` +
        '(e.g. "localhost,mcp"), not bind addresses; requests will be rejected with "Invalid Host". Leave it empty for local use.',
    );
  }
  const app = createMcpExpressApp({ host: config.host, allowedHosts: config.allowedHosts });

  app.get('/health', async (_req: Request, res: Response) => {
    try {
      const dir = await repository.directory.get();
      res.json({ status: 'ok', schemes: dir.schemes.length, directory_loaded_at: dir.loadedAt });
    } catch (err) {
      res.status(503).json({ status: 'degraded', error: (err as Error).message });
    }
  });

  app.use('/mcp', (req: Request, res: Response, next: NextFunction) => {
    if (authorized(req.headers.authorization)) return next();
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    const server = createMfServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp] request failed:', err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server)' }, id: null });
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  // Warm the AMFI directory so the first user question is fast.
  repository.directory.get().catch((err) => console.error('[amfi] warm-up failed:', err.message));

  await new Promise<void>((resolve) => {
    app.listen(config.port, config.host, () => {
      console.error(`[mcp] India MF MCP server listening on http://${config.host}:${config.port}/mcp`);
      resolve();
    });
  });
}
