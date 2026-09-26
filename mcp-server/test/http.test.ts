import { spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PORT = 3190 + Math.floor(Math.random() * 50);
const TOKEN = 'test-mcp-token';
const url = `http://127.0.0.1:${PORT}/mcp`;
let child: ChildProcess;

beforeAll(async () => {
  child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', '--http'], {
    // Empty MCP_ALLOWED_HOSTS mirrors a fresh .env copied from .env.example.
    env: { ...process.env, MCP_PORT: String(PORT), MCP_AUTH_TOKEN: TOKEN, MCP_ALLOWED_HOSTS: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MCP HTTP server did not start')), 20_000);
    child.stderr!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}, 30_000);

afterAll(() => {
  child?.kill();
});

describe('Streamable HTTP transport', () => {
  it('rejects requests without the bearer token', async () => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
  });

  it('serves tools to an authenticated MCP client', async () => {
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }),
    );
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('search_funds');
    const res = await client.callTool({ name: 'search_funds', arguments: { query: 'sbi small cap', limit: 1 } });
    expect(res.isError).toBeFalsy();
    await client.close();
  }, 30_000);

  it('blocks DNS-rebinding style Host headers', async () => {
    // fetch() can't override Host, so use node:http directly.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: PORT, path: '/mcp', method: 'POST', headers: { Host: 'evil.example', Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
    expect(status).toBe(403);
  });
});
