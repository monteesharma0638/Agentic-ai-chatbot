import { GoogleGenAI } from '@google/genai';
import { MfAgent } from './agent/agent.js';
import { loadConfig } from './config.js';
import { createApp } from './http/app.js';
import { logger } from './logger.js';
import { loadMcpConfig, McpHub } from './mcp/hub.js';
import { createPortfolioProvider } from './portfolio/providers.js';
import { MemoryStore, RedisStore, type ConversationStore } from './store/conversations.js';

async function main() {
  const config = loadConfig();

  const hub = new McpHub(loadMcpConfig(config.MCP_CONFIG, config.MCP_SERVERS), logger);
  await hub.init();

  const ttlMs = config.CONVERSATION_TTL_HOURS * 3_600_000;
  const store: ConversationStore = config.REDIS_URL
    ? await RedisStore.connect(config.REDIS_URL, ttlMs, logger)
    : new MemoryStore(ttlMs);

  const portfolio = await createPortfolioProvider(config, logger);

  const genai = new GoogleGenAI({
    apiKey: config.GEMINI_API_KEY,
    // No SDK-level retries: the agent fails over to the next model immediately instead of waiting.
    httpOptions: { retryOptions: { attempts: 1 } },
  });

  const agent = new MfAgent({ model: genai.models, hub, store, config, log: logger, portfolio });
  const app = createApp({ agent, hub, store, config, log: logger });

  const server = app.listen(config.PORT, config.HOST, () => {
    logger.info(`MF agent listening on http://${config.HOST}:${config.PORT} (model ${config.GEMINI_MODEL})`);
  });
  // SSE replies can take a while when several tools run.
  server.requestTimeout = 180_000;

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close();
    await Promise.allSettled([hub.close(), store.close?.(), portfolio?.close?.()]);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal(err.message);
  process.exit(1);
});
