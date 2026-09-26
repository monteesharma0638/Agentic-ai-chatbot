import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ErrorCode, McpError, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Logger } from '../logger.js';

const ServerSchema = z.discriminatedUnion('transport', [
  z.object({
    name: z.string(),
    transport: z.literal('http'),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
    allowTools: z.array(z.string()).optional(),
  }),
  z.object({
    // Runs the bundled India MF MCP server inside this process (single-function hosts such as Vercel).
    name: z.string(),
    transport: z.literal('inprocess'),
    allowTools: z.array(z.string()).optional(),
  }),
  z.object({
    name: z.string(),
    transport: z.literal('stdio'),
    command: z.string(),
    args: z.array(z.string()).default([]),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    allowTools: z.array(z.string()).optional(),
  }),
]);
const McpConfigSchema = z.object({ servers: z.array(ServerSchema).min(1) });

export type McpServerConfig = z.infer<typeof ServerSchema>;

/** Replaces `${VAR}` and `${VAR:-default}` with environment values. */
function interpolate(text: string, env: NodeJS.ProcessEnv): string {
  return text.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/gi, (_, name: string, fallback?: string) => env[name] || fallback || '');
}

export function loadMcpConfig(path: string, inlineJson: string | undefined, env = process.env): McpServerConfig[] {
  const raw = inlineJson ?? readFileSync(resolve(path), 'utf8');
  const parsed = McpConfigSchema.parse(JSON.parse(interpolate(raw, env)));
  for (const s of parsed.servers) {
    if (s.transport === 'http' && s.headers) {
      // Drop auth headers whose variable was unset (e.g. "Bearer ").
      for (const [k, v] of Object.entries(s.headers)) if (!v.trim() || v.trim() === 'Bearer') delete s.headers[k];
    }
  }
  return parsed.servers;
}

export interface HubTool {
  /** Name exposed to the model (prefixed only on collisions). */
  name: string;
  server: string;
  tool: Tool;
}

export interface ToolCallResult {
  ok: boolean;
  /** Parsed JSON when the tool returned JSON text, otherwise the raw text. */
  data: unknown;
  text: string;
}

class Connection {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  tools: Tool[] = [];

  constructor(
    readonly config: McpServerConfig,
    private readonly log: Logger,
  ) {}

  get connected(): boolean {
    return this.client !== null;
  }

  private async createTransport(): Promise<Transport> {
    const c = this.config;
    if (c.transport === 'inprocess') {
      const [{ InMemoryTransport }, mf] = await Promise.all([
        import('@modelcontextprotocol/sdk/inMemory.js'),
        // Relative path, not the workspace package name: Vercel's bundler drops workspace
        // symlinks from node_modules, but keeps this file at the same relative location.
        import('../../../mcp-server/dist/server.js'),
      ]);
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await mf.createMfServer().connect(serverSide);
      // Start downloading the AMFI scheme list now so the first question is fast.
      mf.repository.directory.get().catch((err: Error) => this.log.warn({ err: err.message }, 'AMFI warm-up failed'));
      return clientSide;
    }
    if (c.transport === 'http') {
      return new StreamableHTTPClientTransport(new URL(c.url), { requestInit: { headers: c.headers ?? {} } });
    }
    return new StdioClientTransport({
      command: c.command === 'node' ? process.execPath : c.command,
      args: c.args,
      cwd: c.cwd,
      env: { ...(process.env as Record<string, string>), ...c.env },
      stderr: 'inherit',
    });
  }

  async ensure(): Promise<Client> {
    if (this.client) return this.client;
    this.connecting ??= (async () => {
      const client = new Client({ name: 'mf-agent-service', version: '1.0.0' });
      client.onclose = () => {
        this.client = null;
      };
      await client.connect(await this.createTransport());
      const { tools } = await client.listTools();
      const allow = this.config.allowTools;
      this.tools = allow ? tools.filter((t) => allow.includes(t.name)) : tools;
      this.client = client;
      this.log.info({ server: this.config.name, tools: this.tools.length }, 'MCP server connected');
      return client;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async reset(): Promise<void> {
    const c = this.client;
    this.client = null;
    await c?.close().catch(() => undefined);
  }
}

/**
 * Connects to one or more MCP servers and presents their tools as a single
 * catalogue. Connections are lazy and self-healing: a failed call triggers one
 * reconnect + retry, so restarting the MCP server never requires restarting
 * the agent.
 */
export class McpHub {
  private readonly connections: Connection[];
  private catalogue = new Map<string, { conn: Connection; toolName: string; tool: Tool }>();

  constructor(configs: McpServerConfig[], private readonly log: Logger) {
    this.connections = configs.map((c) => new Connection(c, log));
  }

  /** Connects to every server; failures are logged, not fatal (retried on demand). */
  async init(): Promise<void> {
    await Promise.all(
      this.connections.map((c) =>
        c.ensure().catch((err) => this.log.warn({ server: c.config.name, err: err.message }, 'MCP server unavailable; will retry')),
      ),
    );
    this.rebuildCatalogue();
  }

  private rebuildCatalogue(): void {
    const counts = new Map<string, number>();
    for (const c of this.connections) for (const t of c.tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
    this.catalogue.clear();
    for (const c of this.connections) {
      for (const t of c.tools) {
        const name = counts.get(t.name)! > 1 ? `${c.config.name}__${t.name}` : t.name;
        this.catalogue.set(name, { conn: c, toolName: t.name, tool: t });
      }
    }
  }

  /** Current tool list; reconnects to any server that is down first. */
  async listTools(): Promise<HubTool[]> {
    if (this.connections.some((c) => !c.connected)) await this.init();
    return [...this.catalogue.entries()].map(([name, v]) => ({ name, server: v.conn.config.name, tool: v.tool }));
  }

  has(name: string): boolean {
    return this.catalogue.has(name);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<ToolCallResult> {
    const entry = this.catalogue.get(name);
    if (!entry) return { ok: false, data: { error: `Unknown tool: ${name}` }, text: `Unknown tool: ${name}` };

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const client = await entry.conn.ensure();
        const res = await client.callTool({ name: entry.toolName, arguments: args }, undefined, {
          signal: opts.signal,
          timeout: opts.timeoutMs,
        });
        const blocks = (res.content ?? []) as { type: string; text?: string }[];
        const text = blocks
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text)
          .join('\n');
        let data: unknown = res.structuredContent ?? text;
        if (!res.structuredContent) {
          try {
            data = JSON.parse(text);
          } catch {
            // Plain-text tool output.
          }
        }
        return { ok: !res.isError, data, text };
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        const message = (err as Error).message;
        // Protocol errors (timeouts, invalid params) won't be fixed by reconnecting.
        if (err instanceof McpError) {
          const reason = err.code === ErrorCode.RequestTimeout ? 'Tool timed out' : message;
          return { ok: false, data: { error: reason }, text: reason };
        }
        if (attempt === 0) {
          this.log.warn({ tool: name, err: message }, 'MCP call failed; reconnecting and retrying once');
          await entry.conn.reset();
          continue;
        }
        return { ok: false, data: { error: `Tool unavailable: ${message}` }, text: message };
      }
    }
    return { ok: false, data: { error: 'Tool unavailable' }, text: 'Tool unavailable' };
  }

  status() {
    return this.connections.map((c) => ({ name: c.config.name, connected: c.connected, tools: c.tools.length }));
  }

  async close(): Promise<void> {
    await Promise.all(this.connections.map((c) => c.reset()));
  }
}
