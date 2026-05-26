import { GoogleGenAI } from '@google/genai';
import { readChatText, type MessageRow } from '../agentmeet/types.js';

export interface TranscriptTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly author: string;
}

export interface BuildPromptInput {
  readonly history: readonly MessageRow[];
  readonly selfAgentId: string | null;
  readonly windowSize?: number;
}

const DEFAULT_WINDOW = 20;

/**
 * Convert a slice of AgentMeet message rows into Gemini generateContent turns.
 * The agent's own past messages become `assistant` (mapped to Gemini `model` at
 * call time), everyone else's become `user`. Non-chat kinds and rows with no
 * text are dropped.
 */
export function buildTranscript(input: BuildPromptInput): TranscriptTurn[] {
  const window = input.windowSize ?? DEFAULT_WINDOW;
  const slice = input.history.slice(-window);
  const turns: TranscriptTurn[] = [];
  for (const row of slice) {
    if (row.kind !== 'chat') continue;
    const chat = readChatText(row.body);
    if (!chat) continue;
    const isSelf = input.selfAgentId !== null && row.senderAgentId === input.selfAgentId;
    const author = isSelf
      ? 'me'
      : (row.senderAgentId ?? row.senderUserId ?? 'unknown').slice(0, 8);
    turns.push({
      role: isSelf ? 'assistant' : 'user',
      content: isSelf ? chat.text : `${author}: ${chat.text}`,
      author,
    });
  }
  return turns;
}

/**
 * Collapse consecutive same-role turns — Gemini's generateContent expects
 * alternating user / model turns starting with `user`. We join same-role runs
 * with newlines.
 */
export function collapseTurns(turns: readonly TranscriptTurn[]): TranscriptTurn[] {
  const out: TranscriptTurn[] = [];
  for (const turn of turns) {
    const last = out[out.length - 1];
    if (last && last.role === turn.role) {
      out[out.length - 1] = {
        role: last.role,
        author: last.author,
        content: `${last.content}\n${turn.content}`,
      };
    } else {
      out.push({ ...turn });
    }
  }
  // Gemini requires the first message to be `user`.
  while (out.length > 0 && out[0]?.role !== 'user') out.shift();
  return out;
}

export interface FormatReplyInput {
  readonly raw: string;
  readonly maxLength?: number;
}

const DEFAULT_MAX_REPLY = 4000;

export function formatReply(input: FormatReplyInput): string {
  const max = input.maxLength ?? DEFAULT_MAX_REPLY;
  const trimmed = input.raw.trim();
  if (trimmed.length === 0) return '(no reply)';
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

export interface GeminiResponderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly persona: string;
  readonly maxTokens?: number;
}

export class GeminiResponder {
  private readonly client: GoogleGenAI;
  private readonly model: string;
  private readonly persona: string;
  private readonly maxTokens: number;

  constructor(opts: GeminiResponderOptions) {
    const baseUrl = process.env.GEMINI_BASE_URL;
    this.client = new GoogleGenAI(
      baseUrl
        ? { apiKey: opts.apiKey, httpOptions: { baseUrl } }
        : { apiKey: opts.apiKey },
    );
    this.model = opts.model;
    this.persona = opts.persona;
    this.maxTokens = opts.maxTokens ?? 1024;
  }

  public async respond(turns: readonly TranscriptTurn[]): Promise<string> {
    const collapsed = collapseTurns(turns);
    if (collapsed.length === 0) {
      return '(no context to respond to)';
    }
    const contents = collapsed.map((t) => ({
      role: t.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: t.content }],
    }));
    const res = await this.client.models.generateContent({
      model: this.model,
      contents,
      config: {
        systemInstruction: this.persona,
        maxOutputTokens: this.maxTokens,
      },
    });
    // The new SDK exposes `text` as a getter that joins all text parts.
    // It can be undefined if the response contained no text parts (e.g. only
    // tool calls or a safety block) — fall back to empty string.
    const text = res.text ?? '';
    return formatReply({ raw: text });
  }
}
