// Long-running server entry (local dev, VPS, Docker). Vercel uses vercel.ts instead.
import { createAgentRuntime } from './bootstrap.js';
import { logger } from './logger.js';

async function main() {
  const { app, config, close } = await createAgentRuntime();

  const server = app.listen(config.PORT, config.HOST, () => {
    logger.info(`MF agent listening on http://${config.HOST}:${config.PORT} (model ${config.GEMINI_MODEL})`);
  });
  // SSE replies can take a while when several tools run.
  server.requestTimeout = 180_000;

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close();
    await close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal(err.message);
  process.exit(1);
});
