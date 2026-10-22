import type { Content } from '@google/genai';
import { z } from 'zod';

export interface Holding {
  scheme_code: number;
  units: number;
  invested_amount?: number;
  /** amount > 0 = purchase/SIP, < 0 = redemption. */
  transactions?: { date: string; amount: number }[];
}

/** Unknown values (e.g. from an older widget) are dropped rather than failing the whole message. */
const answer = <T extends [string, ...string[]]>(values: T) => z.enum(values).optional().catch(undefined);

/**
 * The user's answers to the widget's quick questions before the first chat. Fixed choices only, so
 * nothing free-form from the browser reaches the system prompt.
 */
export const InvestorProfileSchema = z.object({
  age: answer(['18-35', '36-50', '50+']),
  experience: answer(['new', 'some', 'regular']),
  goal: answer(['wealth', 'big_goal', 'retirement', 'tax', 'income']),
  horizon: answer(['under_3y', '3_7y', 'over_7y']),
  reaction: answer(['sell', 'wait', 'buy_more']),
  risk: answer(['conservative', 'moderate', 'aggressive']),
});

/**
 * A file the user attached to one message (a screenshot, photo or PDF). Sent to the model for that
 * turn only and never stored: the agent strips these parts before persisting the conversation.
 * `data` is base64 with no `data:` prefix; its size is bounded by the chat route's body limit.
 */
export const AttachmentSchema = z.object({
  mime_type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  data: z.string().min(1).max(6_000_000),
  name: z.string().max(200).optional(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

/** Body the widget POSTs. Identity never comes from the body — it comes from the verified token. */
export const ChatBodySchema = z.object({
  message: z.string().trim().min(1),
  /** Unknown/oversized attachments are dropped rather than failing the whole message. */
  attachments: z.array(AttachmentSchema).max(4).optional().catch(undefined),
  conversation_id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/, 'conversation_id must be 8-64 chars [A-Za-z0-9_-]')
    .optional(),
  context: z
    .object({
      page: z.string().max(50).optional(),
      scheme_code: z.coerce.number().int().positive().optional(),
      scheme_name: z.string().max(200).optional(),
    })
    .nullish(),
  profile: InvestorProfileSchema.nullish().catch(undefined),
});

export type ChatBody = z.infer<typeof ChatBodySchema>;
export type PageContext = NonNullable<ChatBody['context']>;
export type InvestorProfile = z.infer<typeof InvestorProfileSchema>;

export interface ChatUser {
  /** Verified user id (from the signed token) or `guest:<visitor id>`. */
  id: string;
  name?: string;
  risk_profile?: string;
  guest: boolean;
}

export interface ChatInput {
  message: string;
  conversationId?: string;
  user: ChatUser;
  context?: PageContext | null;
  profile?: InvestorProfile | null;
  /** Files attached to this message; sent to the model once and never stored. */
  attachments?: Attachment[];
}

export interface ChartSeries {
  name: string;
  points: [string, number][];
}

interface ChartBase {
  title: string;
  subtitle?: string;
}

/** Change over time (NAV history, SIP growth). The last series is the headline; earlier ones are grey context. */
export interface LineChart extends ChartBase {
  kind: 'line';
  y_label?: string;
  series: ChartSeries[];
}

/** Compare amounts or returns. `muted` bars are grey reference points such as "Money put in". */
export interface BarChart extends ChartBase {
  kind: 'bar';
  unit: 'inr' | 'pct';
  bars: { label: string; value: number; muted?: boolean }[];
}

/** Part-to-whole at a glance (e.g. where a portfolio's money is): 3–5 slices, the last may be "Others". */
export interface DonutChart extends ChartBase {
  kind: 'donut';
  center_label?: string;
  slices: { label: string; value: number; other?: boolean }[];
}

export type Chart = LineChart | BarChart | DonutChart;

export interface Usage {
  prompt_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  total_tokens: number;
}

export type AgentEvent =
  | { type: 'meta'; conversation_id: string }
  | { type: 'tool_start'; id: string; name: string; label: string; args: Record<string, unknown> }
  | { type: 'tool_end'; id: string; name: string; ok: boolean; ms: number }
  | { type: 'chart'; chart: Chart }
  | { type: 'delta'; text: string }
  /** A model failed mid-answer; the UI should reset the reply to `reply` before the retry streams in. */
  | { type: 'rewind'; reply: string }
  | { type: 'done'; conversation_id: string; reply: string; model: string; steps: number; usage: Usage }
  | { type: 'error'; code: string; message: string };

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  text: string;
  charts?: Chart[];
  at: string;
}

export interface ConversationRecord {
  id: string;
  userId: string;
  /** Gemini-format history (compacted). */
  contents: Content[];
  /** Display transcript for re-rendering the chat UI. */
  transcript: TranscriptMessage[];
  createdAt: string;
  updatedAt: string;
}
