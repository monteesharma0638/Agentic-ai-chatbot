import { randomUUID } from 'node:crypto';
import {
  FunctionCallingConfigMode,
  type Content,
  type FunctionCall,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type Part,
  type ThinkingLevel,
} from '@google/genai';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { McpHub, ToolCallResult } from '../mcp/hub.js';
import type { PortfolioProvider } from '../portfolio/providers.js';
import { conversationKey, type ConversationStore } from '../store/conversations.js';
import { compactHistory, mergeTextParts } from './history.js';
import { LOCAL_TOOLS, type LocalToolContext } from './localTools.js';
import { chartFromToolResult, toolLabel } from './presentation.js';
import { buildSystemInstruction } from './prompt.js';
import { toFunctionDeclaration } from './schema.js';
import type { AgentEvent, Chart, ChatInput, ConversationRecord, Usage } from './types.js';

/** The subset of `GoogleGenAI.models` the agent needs — lets tests inject a fake model. */
export interface ModelClient {
  generateContentStream(params: GenerateContentParameters): Promise<AsyncGenerator<GenerateContentResponse>>;
}

export class AgentError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const MAX_TOOL_RESULT_CHARS = 24_000;
const MAX_TRANSCRIPT = 100;
/** Errors worth retrying on another model: not found, quota, overload, server errors, stalls. */
const FAILOVER_STATUSES = new Set([404, 408, 429, 500, 502, 503, 504]);

class StallError extends Error {
  readonly status = 504;
  constructor(ms: number) {
    super(`Model stream stalled for ${ms} ms`);
  }
}

/** Yields from `stream`, failing if the next chunk (including the first) takes longer than `ms`. */
async function* withStallTimeout<T>(stream: AsyncGenerator<T>, ms: number, onStall: () => void): AsyncGenerator<T> {
  for (;;) {
    let timer: NodeJS.Timeout | undefined;
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onStall();
        reject(new StallError(ms));
      }, ms);
    });
    try {
      const next = await Promise.race([stream.next(), stalled]);
      if (next.done) return;
      yield next.value;
    } finally {
      clearTimeout(timer);
    }
  }
}

interface StepResult {
  parts: Part[];
  calls: FunctionCall[];
  text: string;
  finishReason?: string;
  blockReason?: string;
  usage?: GenerateContentResponse['usageMetadata'];
  model: string;
}

function errorStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown })?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * The agentic loop: Gemini decides which MCP tools to call, the agent executes
 * them (in parallel), feeds results back, and streams the final answer.
 * Emits UI-friendly events so the same loop powers SSE and JSON endpoints.
 */
export class MfAgent {
  private readonly active = new Set<string>();
  /** Models that rejected the thinking level; they are called without one. */
  private readonly noThinking = new Set<string>();
  /** Models that recently failed (overload, quota, stall) are tried last until this time. */
  private readonly coolingUntil = new Map<string, number>();

  constructor(
    private readonly deps: {
      model: ModelClient;
      hub: McpHub;
      store: ConversationStore;
      config: AppConfig;
      log: Logger;
      portfolio?: PortfolioProvider | null;
    },
  ) {}

  private thinkingConfig(model: string) {
    const level = this.deps.config.GEMINI_THINKING_LEVEL;
    return level && !this.noThinking.has(model) ? { thinkingLevel: level.toUpperCase() as ThinkingLevel } : undefined;
  }

  /** Configured model chain, with recently failed models moved to the end. */
  private modelOrder(): string[] {
    const { GEMINI_MODEL, GEMINI_FALLBACK_MODELS } = this.deps.config;
    const models = [...new Set([GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS])];
    const now = Date.now();
    const healthy = models.filter((m) => (this.coolingUntil.get(m) ?? 0) <= now);
    return [...healthy, ...models.filter((m) => !healthy.includes(m))];
  }

  /**
   * Runs one model turn with failover. If a model fails before or while
   * streaming (503 "high demand", quota, stall), the partial text is rewound in
   * the UI and the next model in the chain answers the same turn. Nothing is
   * lost because tool calls only run after a turn completes.
   */
  private async *streamStep(
    params: Omit<GenerateContentParameters, 'model'>,
    ctx: { signal?: AbortSignal; replyBefore: string; forceAnswer: boolean },
  ): AsyncGenerator<AgentEvent, StepResult> {
    const { config, log } = this.deps;
    let lastError: unknown;

    for (const model of this.modelOrder()) {
      for (let thinkingRetry = 0; thinkingRetry < 2; thinkingRetry++) {
        const attempt = new AbortController();
        const abortSignal = ctx.signal ? AbortSignal.any([ctx.signal, attempt.signal]) : attempt.signal;
        const result: StepResult = { parts: [], calls: [], text: '', model };
        let emitted = false;
        try {
          const stream = await this.deps.model.generateContentStream({
            ...params,
            model,
            config: { ...params.config, abortSignal, thinkingConfig: this.thinkingConfig(model) },
          });
          for await (const chunk of withStallTimeout(stream, config.MODEL_STALL_TIMEOUT_MS, () => attempt.abort())) {
            result.blockReason ??= chunk.promptFeedback?.blockReason;
            const candidate = chunk.candidates?.[0];
            result.finishReason = candidate?.finishReason ?? result.finishReason;
            for (const part of candidate?.content?.parts ?? []) {
              result.parts.push(part);
              if (part.functionCall) {
                if (!ctx.forceAnswer) result.calls.push(part.functionCall);
              } else if (part.text && !part.thought) {
                if (!result.text && ctx.replyBefore && !ctx.replyBefore.endsWith('\n')) {
                  result.text += '\n\n';
                  yield { type: 'delta', text: '\n\n' };
                }
                result.text += part.text;
                emitted = true;
                yield { type: 'delta', text: part.text };
              }
            }
            // Usage metadata is cumulative within a stream; keep the latest.
            result.usage = chunk.usageMetadata ?? result.usage;
          }
          this.coolingUntil.delete(model);
          return result;
        } catch (err) {
          if (ctx.signal?.aborted) throw err;
          lastError = err;
          if (emitted) yield { type: 'rewind', reply: ctx.replyBefore };
          const status = errorStatus(err);
          const message = (err as Error).message ?? String(err);
          if (status === 400 && /thinking/i.test(message) && !this.noThinking.has(model)) {
            log.warn({ model }, 'Model rejected the thinking level; calling it without one');
            this.noThinking.add(model);
            continue;
          }
          if (status !== undefined && FAILOVER_STATUSES.has(status)) {
            this.coolingUntil.set(model, Date.now() + config.MODEL_COOLDOWN_SECONDS * 1000);
            log.warn({ model, status, err: message.slice(0, 200) }, 'Model failed; switching to the next model');
            break;
          }
          throw err;
        }
      }
    }
    throw lastError;
  }

  private async executeTool(call: FunctionCall, ctx: LocalToolContext): Promise<ToolCallResult> {
    const name = call.name ?? '';
    const args = (call.args ?? {}) as Record<string, unknown>;
    const local = LOCAL_TOOLS.find((t) => t.declaration.name === name && t.enabled(ctx));
    if (local) return local.execute(args, ctx);
    return this.deps.hub.callTool(name, args, { signal: ctx.signal, timeoutMs: ctx.timeoutMs });
  }

  async *chat(req: ChatInput, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const { config, store, hub, log } = this.deps;
    const conversationId = req.conversationId ?? randomUUID();
    const key = conversationKey(req.user.id, conversationId);

    if (this.active.has(key)) {
      yield { type: 'error', code: 'busy', message: 'A reply is already being generated in this conversation.' };
      return;
    }
    this.active.add(key);
    const started = Date.now();

    try {
      yield { type: 'meta', conversation_id: conversationId };

      const now = new Date().toISOString();
      const record: ConversationRecord = (await store.get(key)) ?? {
        id: conversationId,
        userId: req.user.id,
        contents: [],
        transcript: [],
        createdAt: now,
        updatedAt: now,
      };

      const contents: Content[] = [
        ...compactHistory(record.contents, config.HISTORY_MAX_TURNS, config.HISTORY_FULL_TURNS),
        { role: 'user', parts: [{ text: req.message }] },
      ];

      const toolCtx: LocalToolContext = {
        hub,
        user: req.user,
        portfolio: this.deps.portfolio ?? null,
        signal,
        timeoutMs: config.TOOL_TIMEOUT_MS,
      };
      const hubTools = await hub.listTools();
      const localTools = LOCAL_TOOLS.filter((t) => t.enabled(toolCtx));
      const functionDeclarations = [
        ...hubTools.map((t) => toFunctionDeclaration(t.name, t.tool.description, t.tool.inputSchema)),
        ...localTools.map((t) => t.declaration),
      ];
      if (hubTools.length === 0) log.warn('No MCP tools available; answering without live data');

      const systemInstruction = buildSystemInstruction({
        appName: config.APP_NAME,
        assistantName: config.ASSISTANT_NAME,
        user: req.user,
        hasPortfolio: localTools.some((t) => t.declaration.name === 'get_my_portfolio'),
        page: req.context ?? undefined,
      });

      let reply = '';
      let modelUsed = config.GEMINI_MODEL;
      let steps = 0;
      let malformedRetries = 0;
      const charts: Chart[] = [];
      const usage: Usage = { prompt_tokens: 0, output_tokens: 0, thinking_tokens: 0, total_tokens: 0 };
      const toolNames: string[] = [];

      for (let step = 0; step < config.AGENT_MAX_STEPS; step++) {
        steps = step + 1;
        const forceAnswer = step === config.AGENT_MAX_STEPS - 1;
        const turn = yield* this.streamStep(
          {
            contents,
            config: {
              systemInstruction,
              maxOutputTokens: config.GEMINI_MAX_OUTPUT_TOKENS,
              ...(functionDeclarations.length && {
                tools: [{ functionDeclarations }],
                toolConfig: {
                  functionCallingConfig: {
                    mode: forceAnswer ? FunctionCallingConfigMode.NONE : FunctionCallingConfigMode.AUTO,
                  },
                },
              }),
            },
          },
          { signal, replyBefore: reply, forceAnswer },
        );
        modelUsed = turn.model;
        const { parts, calls, finishReason, blockReason } = turn;
        const stepText = turn.text;
        reply += stepText;
        usage.prompt_tokens += turn.usage?.promptTokenCount ?? 0;
        usage.output_tokens += turn.usage?.candidatesTokenCount ?? 0;
        usage.thinking_tokens += turn.usage?.thoughtsTokenCount ?? 0;
        usage.total_tokens += turn.usage?.totalTokenCount ?? 0;

        if (blockReason) {
          throw new AgentError('blocked', "I can't help with that request. Please ask something about mutual funds or investing.");
        }

        if (calls.length === 0 && !stepText.trim()) {
          // Occasionally the model emits an unparsable call or nothing at all; one retry usually fixes it.
          if (malformedRetries++ < 1 && !forceAnswer) {
            log.warn({ finishReason, step }, 'Empty model response; retrying step');
            continue;
          }
          if (!reply.trim()) {
            const text =
              finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT'
                ? "I can't help with that request. Please ask something about mutual funds or investing."
                : "Sorry, I couldn't put together an answer just now. Could you rephrase or try again?";
            reply = text;
            yield { type: 'delta', text };
          }
          break;
        }

        const modelParts = mergeTextParts(parts.filter((p) => !(forceAnswer && p.functionCall)));
        if (modelParts.length) contents.push({ role: 'model', parts: modelParts });
        if (calls.length === 0) break;

        const ids = calls.map((c, i) => c.id ?? `s${step}-${i}`);
        for (const [i, call] of calls.entries()) {
          yield {
            type: 'tool_start',
            id: ids[i],
            name: call.name ?? '',
            label: toolLabel(call.name ?? ''),
            args: (call.args ?? {}) as Record<string, unknown>,
          };
        }

        const results = await Promise.all(
          calls.map(async (call) => {
            const t0 = Date.now();
            const result = await this.executeTool(call, toolCtx).catch((err: Error): ToolCallResult => {
              if (signal?.aborted) throw err;
              return { ok: false, data: { error: err.message }, text: err.message };
            });
            return { call, result, ms: Date.now() - t0 };
          }),
        );

        const responseParts: Part[] = [];
        for (const [i, { call, result, ms }] of results.entries()) {
          const name = call.name ?? '';
          toolNames.push(name);
          log.info({ tool: name, ok: result.ok, ms, args: name === 'get_my_portfolio' ? undefined : call.args }, 'tool call');
          yield { type: 'tool_end', id: ids[i], name, ok: result.ok, ms };

          if (result.ok) {
            const chart = chartFromToolResult(name, result.data);
            if (chart) {
              charts.push(chart);
              yield { type: 'chart', chart };
            }
          }

          let payload: Record<string, unknown>;
          const serialized = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
          if (serialized.length > MAX_TOOL_RESULT_CHARS) {
            payload = { truncated_result: serialized.slice(0, MAX_TOOL_RESULT_CHARS) };
          } else if (!result.ok) {
            const err = (result.data as { error?: unknown })?.error ?? result.text;
            payload = { error: String(err) };
          } else {
            payload = { result: result.data };
          }
          responseParts.push({ functionResponse: { ...(call.id && { id: call.id }), name, response: payload } });
        }
        contents.push({ role: 'user', parts: responseParts });
      }

      const at = new Date().toISOString();
      record.contents = compactHistory(contents, config.HISTORY_MAX_TURNS, config.HISTORY_FULL_TURNS);
      record.transcript = [
        ...record.transcript,
        { role: 'user' as const, text: req.message, at: now },
        { role: 'assistant' as const, text: reply, ...(charts.length && { charts }), at },
      ].slice(-MAX_TRANSCRIPT);
      record.updatedAt = at;
      await store.set(key, record);

      log.info(
        { conversation: conversationId, user: req.user.id, model: modelUsed, steps, tools: toolNames, ms: Date.now() - started, usage },
        'chat completed',
      );
      yield { type: 'done', conversation_id: conversationId, reply, model: modelUsed, steps, usage };
    } catch (err) {
      if (signal?.aborted) {
        log.info({ conversation: conversationId }, 'client disconnected; generation aborted');
        return;
      }
      if (err instanceof AgentError) {
        yield { type: 'error', code: err.code, message: err.message };
        return;
      }
      const status = errorStatus(err);
      log.error({ err: (err as Error).message, status, conversation: conversationId }, 'chat failed');
      yield {
        type: 'error',
        code: status === 429 ? 'rate_limited' : 'model_error',
        message:
          status === 429
            ? 'The assistant is receiving too many requests right now. Please try again in a minute.'
            : 'Something went wrong while generating a reply. Please try again.',
      };
    } finally {
      this.active.delete(key);
    }
  }
}
