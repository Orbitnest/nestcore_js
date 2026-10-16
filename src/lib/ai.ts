import { errorMessage, type HttpClient } from './client';
import type { ApiResult } from '../types';

export type AiProviderId = 'gemini' | 'openai' | 'anthropic' | 'openai_compatible';

/** `url`: a `data:image/png;base64,…` URL, or an https URL (OpenAI and Anthropic only). */
export type AiContentPart = { type: 'text'; text: string } | { type: 'image'; url: string };

export interface AiToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Provider state; send the call back unchanged in the assistant message. */
  signature?: string;
}

export interface AiTool {
  name: string;
  description?: string;
  /** JSON Schema of the arguments object. */
  parameters?: Record<string, unknown>;
}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | AiContentPart[] | null;
  /** assistant: the calls from a previous reply (`toolCalls`). */
  toolCalls?: AiToolCall[];
  /** tool: the id of the call this result answers. */
  toolCallId?: string;
}

export interface AiChatOptions {
  /** Defaults to the project's default model (Studio → Project Settings → AI). */
  model?: string;
  /** Needed only when the model name does not identify the provider. */
  provider?: AiProviderId;
  messages: AiMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: AiTool[];
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
}

export interface AiChatResult {
  text: string;
  /** Calls the model wants made; answer each with a `tool` message and chat again. */
  toolCalls: AiToolCall[];
  model: string;
  provider: AiProviderId;
  tokensIn: number;
  tokensOut: number;
  /** List price; models without a listed price are charged at their provider's top price. */
  costUsd: number;
  finishReason: string | null;
}

export type AiStreamEvent =
  | { type: 'delta'; text: string }
  | ({ type: 'tool_call' } & AiToolCall)
  | { type: 'done'; model: string; tokensIn: number; tokensOut: number; costUsd: number; finishReason: string | null }
  | { type: 'error'; code?: string; message: string; status?: number };

export interface AiEmbedResult {
  model: string;
  provider: AiProviderId;
  dimensions: number;
  embeddings: number[][];
  tokensIn: number;
}

export interface AiModel {
  id: string;
  provider: AiProviderId;
  kind: 'chat' | 'embed';
  default?: boolean;
}

/**
 * AI Gateway: chat and embeddings through the project's own provider keys.
 * Calls need a signed-in user (per-user caps apply) or a service-role key.
 *
 * ```ts
 * const { data } = await client.ai.chat({ messages: [{ role: 'user', content: 'Hi' }] });
 * for await (const ev of client.ai.chatStream({ messages })) {
 *   if (ev.type === 'delta') process.stdout.write(ev.text);
 * }
 * ```
 */
export class AiClient {
  constructor(private client: HttpClient) {}

  private path(p: string): string {
    return `/api/project/${this.client.getProjectSlug()}/ai/v1/${p}`;
  }

  private body(o: AiChatOptions, stream: boolean) {
    return {
      model: o.model,
      provider: o.provider,
      messages: o.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolCalls ? { tool_calls: m.toolCalls } : {}),
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      })),
      temperature: o.temperature,
      max_tokens: o.maxTokens,
      tools: o.tools,
      tool_choice: o.toolChoice,
      stream,
    };
  }

  async chat(options: AiChatOptions): Promise<ApiResult<AiChatResult>> {
    // A model reply can take longer than the default request timeout.
    return this.client.request<AiChatResult>(this.path('chat'), { method: 'POST', body: this.body(options, false), timeout: 120_000 });
  }

  /**
   * Stream a reply: `delta` and `tool_call` events, then one `done` (or `error`).
   * Errors arrive as an `error` event, never as a throw. `signal`, or leaving
   * the loop early, cancels the stream.
   */
  async *chatStream(options: AiChatOptions, { signal }: { signal?: AbortSignal } = {}): AsyncGenerator<AiStreamEvent> {
    let res: Response;
    try {
      res = await this.client.authFetch(`${this.client.getBaseUrl()}${this.path('chat')}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(this.body(options, true)),
        signal,
        redirect: 'error',
      });
    } catch (err) {
      yield { type: 'error', code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : 'Network error' };
      return;
    }
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => null);
      yield { type: 'error', code: data?.code, message: errorMessage(data, res.status), status: res.status };
      return;
    }
    try {
      for await (const raw of sseData(res.body)) yield JSON.parse(raw) as AiStreamEvent;
    } catch (err) {
      yield { type: 'error', code: 'STREAM_ERROR', message: err instanceof Error ? err.message : 'Stream interrupted' };
    }
  }

  /** 768-dimension vectors for one string or up to 100. */
  async embed(input: string | string[], options: { model?: string; provider?: AiProviderId } = {}): Promise<ApiResult<AiEmbedResult>> {
    return this.client.request<AiEmbedResult>(this.path('embeddings'), { method: 'POST', body: { input, ...options } });
  }

  /** Models the project can call with its saved provider keys. */
  async models(): Promise<ApiResult<AiModel[]>> {
    return this.client.request<AiModel[]>(this.path('models'));
  }
}

/** `data:` payloads of a server-sent-events body. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.startsWith('data:')) yield line.slice(5).trimStart();
      }
    }
    if (buf.startsWith('data:')) yield buf.slice(5).trimStart();
  } finally {
    // A consumer that leaves the loop early must close the connection, or the server keeps generating (and billing).
    await reader.cancel().catch(() => {});
  }
}
