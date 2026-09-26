import { GoogleGenAI } from '@google/genai';
import type { Express } from 'express';
import { MfAgent } from './agent/agent.js';
import { loadConfig, type AppConfig } from './config.js';
import { createApp } from './http/app.js';
import { logger } from './logger.js';
import { loadMcpConfig, McpHub, type McpServerConfig } from './mcp/hub.js';
import { createPortfolioProvider } from './portfolio/providers.js';
import { createConversationStore } from './store/conversations.js';

export interface AgentRuntime {
  app: Express;
  config: AppConfig;
  close(): Promise<void>;
}

/**
 * Builds the whole service (config, MCP connections, stores, Gemini agent,
 * HTTP app) without listening on a port, so the same code runs as a
 * long-lived server (VPS) or as a Vercel Function.
 *
 * `defaultMcpServers` is used when MCP_SERVERS isn't set; otherwise the
 * servers come from MCP_SERVERS or the mcp.config.json file.
 */
export async function createAgentRuntime(opts: { defaultMcpServers?: McpServerConfig[] } = {}): Promise<AgentRuntime> {
  const config = loadConfig();

  const servers =
    !config.MCP_SERVERS && opts.defaultMcpServers ? opts.defaultMcpServers : loadMcpConfig(config.MCP_CONFIG, config.MCP_SERVERS);
  const hub = new McpHub(servers, logger);
  await hub.init();

  const store = await createConversationStore(config, logger);
  const portfolio = await createPortfolioProvider(config, logger);

  const genai = new GoogleGenAI({
    apiKey: config.GEMINI_API_KEY,
    // No SDK-level retries: the agent fails over to the next model immediately instead of waiting.
    httpOptions: { retryOptions: { attempts: 1 } },
  });

  const agent = new MfAgent({ model: genai.models, hub, store, config, log: logger, portfolio });
  const app = createApp({ agent, hub, store, config, log: logger });

  return {
    app,
    config,
    async close() {
      await Promise.allSettled([hub.close(), store.close?.(), portfolio?.close?.()]);
    },
  };
}
