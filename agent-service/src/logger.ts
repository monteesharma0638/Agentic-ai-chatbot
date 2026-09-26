import { pino } from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'mf-agent' },
  redact: ['req.headers.authorization', 'headers.Authorization', 'headers.authorization'],
  ...(process.env.NODE_ENV !== 'production' && process.stdout.isTTY
    ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
    : {}),
});

export type Logger = typeof logger;
