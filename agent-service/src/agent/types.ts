import type { Content } from '@google/genai';
import { z } from 'zod';

export interface Holding {
  scheme_code: number;
  units: number;
  invested_amount?: number;
  /** amount > 0 = purchase/SIP, < 0 = redemption. */
  transactions?: { date: string; amount: number }[];
}

/** Body the widget POSTs. Identity never comes from the body — it comes from the verified token. */
export const ChatBodySchema = z.object({
  message: z.string().trim().min(1),
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
});

export type ChatBody = z.infer<typeof ChatBodySchema>;
export type PageContext = NonNullable<ChatBody['context']>;

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
}

export interface ChartSeries {
  name: string;
  points: [string, number][];
}

export interface Chart {
  kind: 'line';
  title: string;
  subtitle?: string;
  y_label?: string;
  series: ChartSeries[];
}

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
