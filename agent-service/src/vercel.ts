// Vercel Function entry (see /api/index.js and /vercel.json). The local/VPS server uses index.ts.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAgentRuntime, type AgentRuntime } from './bootstrap.js';
import { logger } from './logger.js';

let runtime: Promise<AgentRuntime> | null = null;

/** Built once per function instance and reused by every request it serves (Fluid compute). */
function getRuntime(): Promise<AgentRuntime> {
  runtime ??= createAgentRuntime({
    // One function, no second server: the MCP data server runs in-process.
    defaultMcpServers: [{ name: 'india-mf', transport: 'inprocess' }],
  }).catch((err) => {
    runtime = null; // retry on the next request instead of staying broken
    throw err;
  });
  return runtime;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let app: AgentRuntime['app'];
  try {
    ({ app } = await getRuntime());
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'startup failed (check the environment variables in Vercel)');
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'startup_failed' }));
    return;
  }
  // Resolve only when the response is done, so streamed (SSE) replies aren't cut short.
  await new Promise<void>((resolve) => {
    res.once('close', resolve);
    res.once('finish', resolve);
    app(req as Parameters<typeof app>[0], res as Parameters<typeof app>[1]);
  });
}
