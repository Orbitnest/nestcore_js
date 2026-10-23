import { errorMessage, type HttpClient } from './client';
import { sseData } from './sse';
import type { AiContentPart, AiProviderId, AiToolCall } from './ai';
import type { ApiResult } from '../types';

// ── Memory ────────────────────────────────────────────────────────────────

export interface AiMemory {
  id: string;
  subject_type: string;
  subject_id: string;
  kind: string;
  content: string;
  embed_model: string | null;
  importance: number;
  metadata: Record<string, unknown>;
  source_thread_id: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AiMemoryMatch extends AiMemory {
  /** Cosine similarity (null in a keyword fallback). */
  similarity: number | null;
  /** Similarity nudged by importance and recency; results are sorted by it. */
  score: number;
}

export interface MemoryAddOptions {
  /** Service key only: `type:id`, e.g. `user:<id>`, `agent:support`. Signed-in users are always `user:<their id>`. */
  subject?: string;
  /** fact (default), preference, episode, summary, or your own word. */
  kind?: string;
  /** 1–5, default 3. */
  importance?: number;
  /** ISO date; the memory is deleted after it. */
  expiresAt?: string | null;
  metadata?: Record<string, unknown>;
  sourceThreadId?: string;
  /** Update a near-identical memory (cosine ≥ 0.92) instead of adding one. Default true. */
  dedupe?: boolean;
}

/**
 * Memory API: facts about a user (or an agent, an org…) with semantic search.
 * A signed-in user reads and writes only their own memory; the service key may
 * name any subject.
 *
 * ```ts
 * await client.memory.add('Prefers vegetarian recipes', { kind: 'preference' });
 * const { data } = await client.memory.search('what should I cook?');
 * ```
 */
export class MemoryClient {
  constructor(private client: HttpClient) {}

  private path(p = ''): string {
    return `/api/project/${this.client.getProjectSlug()}/ai/v1/memory${p}`;
  }

  /** Remember something. `deduped: true` means an existing near-identical memory was updated. */
  add(content: string, options: MemoryAddOptions = {}): Promise<ApiResult<{ memory: AiMemory; deduped: boolean }>> {
    return this.client.request(this.path(), { method: 'POST', body: { content, ...options } });
  }

  /** Most relevant memories. `degraded: true` = the model provider was down and keyword search answered. */
  search(query: string, options: { subject?: string; k?: number; kind?: string; minSimilarity?: number } = {}): Promise<ApiResult<{ results: AiMemoryMatch[]; degraded: boolean; model: string | null }>> {
    return this.client.request(this.path('/search'), { method: 'POST', body: { query, ...options } });
  }

  list(options: { subject?: string; kind?: string; limit?: number; offset?: number } = {}): Promise<ApiResult<{ memories: AiMemory[]; total: number }>> {
    return this.client.request(this.path(query(options)));
  }

  get(id: string): Promise<ApiResult<AiMemory>> {
    return this.client.request(this.path(`/${encodeURIComponent(id)}`));
  }

  update(id: string, patch: { content?: string; kind?: string; importance?: number; expiresAt?: string | null; metadata?: Record<string, unknown> }): Promise<ApiResult<AiMemory>> {
    return this.client.request(this.path(`/${encodeURIComponent(id)}`), { method: 'PATCH', body: patch });
  }

  remove(id: string): Promise<ApiResult<{ deleted: boolean }>> {
    return this.client.request(this.path(`/${encodeURIComponent(id)}`), { method: 'DELETE' });
  }

  /** Delete every memory of a subject (rows and vectors). Users always forget themselves. */
  forget(subject?: string): Promise<ApiResult<{ deleted: number }>> {
    return this.client.request(this.path('/forget'), { method: 'POST', body: subject ? { subject } : {} });
  }

  /** Service key: subjects that have memories. */
  subjects(options: { type?: string; limit?: number } = {}): Promise<ApiResult<Array<{ subject: string; subject_type: string; subject_id: string; memories: number; last_updated: string }>>> {
    return this.client.request(this.path(`/subjects${query(options)}`));
  }

  /** Service key: re-embed memories made with another model (after a provider change), 64 per call. */
  reembed(options: { subject?: string; limit?: number } = {}): Promise<ApiResult<{ reembedded: number; remaining: number; model: string | null }>> {
    return this.client.request(this.path('/reembed'), { method: 'POST', body: options });
  }
}

// ── Collections ───────────────────────────────────────────────────────────

export interface AiCollection {
  id: string;
  name: string;
  embed_model: string | null;
  embed_provider: AiProviderId | null;
  chunk_tokens: number;
  chunk_overlap: number;
  user_ingest: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  documents?: number;
  pending?: number;
}

export interface AiDocument {
  id: string;
  collection_id: string;
  owner_user_id: string | null;
  source_type: 'text' | 'storage' | 'url';
  source_ref: string | null;
  title: string | null;
  metadata: Record<string, unknown>;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  error: string | null;
  chunk_count: number;
  bytes: number;
  created_at: string;
  updated_at: string;
}

export interface AiSearchResult {
  /** Reciprocal-rank-fusion score (vector + keyword); results are sorted by it. */
  score: number;
  similarity: number | null;
  keywordMatch: boolean;
  /** The best-matching words, wrapped in `**`. */
  highlight: string;
  chunk: { id: string; ordinal: number; content: string; metadata: Record<string, unknown> };
  document: { id: string; title: string | null; sourceType: string; sourceRef: string | null; metadata: Record<string, unknown> };
}

export type DocumentSource = { text: string } | { url: string } | { storage: { bucket: string; path: string } };

export interface IngestOptions {
  title?: string;
  metadata?: Record<string, unknown>;
  /** Service key only: the user who owns (and alone can read) this document. */
  ownerUserId?: string;
  /** Wait until the document is `ready` or `failed` (default: return at once with `queued`). */
  wait?: boolean | { timeoutMs?: number; intervalMs?: number };
}

/** One collection: `client.collections.from('handbook')`. */
export class CollectionRef {
  constructor(private client: HttpClient, readonly name: string) {}

  private path(p = ''): string {
    return `/api/project/${this.client.getProjectSlug()}/ai/v1/collections/${encodeURIComponent(this.name)}${p}`;
  }

  /**
   * Add a document; it is chunked and embedded in the background. PDF, HTML and
   * text files are read from storage or a URL.
   */
  async ingest(source: DocumentSource, options: IngestOptions = {}): Promise<ApiResult<AiDocument>> {
    const { wait, ...rest } = options;
    const res = await this.client.request<AiDocument>(this.path('/documents'), { method: 'POST', body: { ...source, ...rest } });
    if (res.error || !wait) return res;
    return this.waitFor(res.data.id, typeof wait === 'object' ? wait : {});
  }

  /** Poll a document until it is `ready` or `failed`. */
  async waitFor(documentId: string, { timeoutMs = 120_000, intervalMs = 1_000 }: { timeoutMs?: number; intervalMs?: number } = {}): Promise<ApiResult<AiDocument>> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const res = await this.getDocument(documentId);
      if (res.error || res.data.status === 'ready' || res.data.status === 'failed') return res;
      if (Date.now() > until) return { data: null, error: { message: `Document ${documentId} is still ${res.data.status}`, code: 'TIMEOUT' } };
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  /** Hybrid search (vector + keyword). `hybrid: false` is vector only; `filter` matches document metadata. */
  search(query: string, options: { k?: number; hybrid?: boolean; filter?: Record<string, unknown>; minSimilarity?: number } = {}): Promise<ApiResult<{ results: AiSearchResult[]; model: string | null }>> {
    return this.client.request(this.path('/search'), { method: 'POST', body: { query, ...options } });
  }

  listDocuments(options: { status?: AiDocument['status']; limit?: number; offset?: number } = {}): Promise<ApiResult<{ documents: AiDocument[]; total: number }>> {
    return this.client.request(this.path(`/documents${query(options)}`));
  }

  getDocument(id: string): Promise<ApiResult<AiDocument>> {
    return this.client.request(this.path(`/documents/${encodeURIComponent(id)}`));
  }

  /** Delete a document and its chunks. */
  remove(documentId: string): Promise<ApiResult<{ deleted: boolean }>> {
    return this.client.request(this.path(`/documents/${encodeURIComponent(documentId)}`), { method: 'DELETE' });
  }

  stats(): Promise<ApiResult<{ chunks: number; current_model_chunks: number; documents: number; failed: number; model: string | null }>> {
    return this.client.request(this.path('/stats'));
  }
}

/**
 * Vector collections: documents chunked, embedded and searched with hybrid
 * retrieval under RLS. Creating collections and adding shared documents needs
 * the service key; a collection with `userIngest` lets signed-in users add
 * documents only they can read.
 *
 * ```ts
 * await admin.collections.create({ name: 'handbook' });
 * await admin.collections.from('handbook').ingest({ url: 'https://example.com/guide.pdf' }, { wait: true });
 * const { data } = await client.collections.from('handbook').search('How do refunds work?');
 * ```
 */
export class CollectionsClient {
  constructor(private client: HttpClient) {}

  private path(p = ''): string {
    return `/api/project/${this.client.getProjectSlug()}/ai/v1/collections${p}`;
  }

  from(name: string): CollectionRef {
    return new CollectionRef(this.client, name);
  }

  create(options: { name: string; model?: string; provider?: AiProviderId; chunkTokens?: number; chunkOverlap?: number; userIngest?: boolean; metadata?: Record<string, unknown> }): Promise<ApiResult<AiCollection>> {
    return this.client.request(this.path(), { method: 'POST', body: options });
  }

  list(): Promise<ApiResult<AiCollection[]>> {
    return this.client.request(this.path());
  }

  get(name: string): Promise<ApiResult<AiCollection>> {
    return this.client.request(this.path(`/${encodeURIComponent(name)}`));
  }

  /** Changing `model` re-embeds every chunk in the background. */
  update(name: string, patch: { userIngest?: boolean; metadata?: Record<string, unknown>; model?: string; provider?: AiProviderId }): Promise<ApiResult<AiCollection>> {
    return this.client.request(this.path(`/${encodeURIComponent(name)}`), { method: 'PATCH', body: patch });
  }

  delete(name: string): Promise<ApiResult<{ deleted: boolean }>> {
    return this.client.request(this.path(`/${encodeURIComponent(name)}`), { method: 'DELETE' });
  }
}

// ── Threads ───────────────────────────────────────────────────────────────

export interface AiThread {
  id: string;
  owner_user_id: string | null;
  title: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  messages?: number;
  cost_usd?: number;
}

export type AiThreadPart = AiContentPart | { type: 'image'; storage: { bucket: string; path: string } };

export interface AiThreadMessage {
  id: string;
  thread_id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: AiThreadPart[];
  model: string | null;
  provider: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  /** `streaming` while a run writes it (partial text), `error` if the run failed. */
  status: 'streaming' | 'complete' | 'error';
  error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface AiCitation {
  index: number;
  collection: string;
  documentId: string;
  chunkId: string;
  title: string | null;
  sourceRef: string | null;
  snippet: string;
  score: number;
}

export interface ThreadRunOptions {
  /** Appended as a user message first. */
  input?: string | AiThreadPart[];
  model?: string;
  provider?: AiProviderId;
  system?: string;
  temperature?: number;
  maxTokens?: number;
  /** true = the user's memories as context; with the service key a `type:id` subject. */
  memory?: boolean | string;
  /** Collections searched for sources the model cites as [n]. */
  collections?: string[];
  /** Built-in tools the model may call. */
  tools?: Array<'memory_search' | 'collections_search'>;
  /** History + context budget in tokens (default 8000). */
  maxContextTokens?: number;
}

export type ThreadRunEvent =
  | { type: 'message'; threadId: string; messageId: string }
  | ({ type: 'citation' } & AiCitation)
  | { type: 'delta'; text: string }
  | ({ type: 'tool_call' } & AiToolCall)
  | { type: 'tool_result'; id: string; name: string; result: unknown }
  | { type: 'done'; messageId: string; model: string; provider: string | null; tokensIn: number; tokensOut: number; costUsd: number }
  | { type: 'error'; code?: string; message: string; status?: number };

export interface ThreadRunResult {
  messageId: string;
  text: string;
  citations: AiCitation[];
  toolCalls: Array<{ id: string; name: string; result: unknown }>;
  usage: { model: string; provider: string | null; tokensIn: number; tokensOut: number; costUsd: number } | null;
}

/** One thread: `client.ai.threads.from(id)`. */
export class ThreadRef {
  constructor(private client: HttpClient, readonly id: string) {}

  private path(p = ''): string {
    return `/api/project/${this.client.getProjectSlug()}/ai/v1/threads/${encodeURIComponent(this.id)}${p}`;
  }

  get(): Promise<ApiResult<AiThread>> {
    return this.client.request(this.path());
  }

  update(patch: { title?: string | null; metadata?: Record<string, unknown> }): Promise<ApiResult<AiThread>> {
    return this.client.request(this.path(), { method: 'PATCH', body: patch });
  }

  delete(): Promise<ApiResult<{ deleted: boolean }>> {
    return this.client.request(this.path(), { method: 'DELETE' });
  }

  /** Oldest first: the newest `limit`, or those created after `after` (resume after a reconnect). */
  messages(options: { limit?: number; after?: string } = {}): Promise<ApiResult<AiThreadMessage[]>> {
    return this.client.request(this.path(`/messages${query(options)}`));
  }

  /** Add a message without running the model (users may add `user` messages only). */
  append(content: string | AiThreadPart[], options: { role?: 'user' | 'assistant' | 'system'; metadata?: Record<string, unknown> } = {}): Promise<ApiResult<AiThreadMessage>> {
    return this.client.request(this.path('/messages'), { method: 'POST', body: { content, ...options } });
  }

  /**
   * Stream the assistant's next message: `message` (its id), `citation`s,
   * `delta`s, tool events, then `done` (or `error`). The reply is saved as it
   * streams, so another device can read it with `messages()` or listen on the
   * realtime channel `broadcast:ai:thread:<id>`. Leaving the loop early cancels.
   */
  async *run(options: ThreadRunOptions = {}, { signal }: { signal?: AbortSignal } = {}): AsyncGenerator<ThreadRunEvent> {
    let res: Response;
    try {
      res = await this.client.authFetch(`${this.client.getBaseUrl()}${this.path('/run')}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ ...options, stream: true }),
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
      for await (const raw of sseData(res.body)) yield JSON.parse(raw) as ThreadRunEvent;
    } catch (err) {
      yield { type: 'error', code: 'STREAM_ERROR', message: err instanceof Error ? err.message : 'Stream interrupted' };
    }
  }

  /** Run and wait for the finished message (no streaming). */
  runOnce(options: ThreadRunOptions = {}): Promise<ApiResult<ThreadRunResult>> {
    return this.client.request(this.path('/run'), { method: 'POST', body: { ...options, stream: false }, timeout: 180_000 });
  }
}

/**
 * Threads: persistent conversations with per-message tokens and cost. A
 * signed-in user owns the threads they create; the service key can create
 * threads for any user (`ownerUserId`).
 *
 * ```ts
 * const { data: t } = await client.ai.threads.create({ title: 'Trip ideas' });
 * for await (const ev of client.ai.threads.from(t.id).run({ input: 'Plan a weekend in Oslo', memory: true })) {
 *   if (ev.type === 'delta') process.stdout.write(ev.text);
 * }
 * ```
 */
export class ThreadsClient {
  constructor(private client: HttpClient) {}

  private path(p = ''): string {
    return `/api/project/${this.client.getProjectSlug()}/ai/v1/threads${p}`;
  }

  from(id: string): ThreadRef {
    return new ThreadRef(this.client, id);
  }

  create(options: { title?: string; metadata?: Record<string, unknown>; ownerUserId?: string } = {}): Promise<ApiResult<AiThread>> {
    return this.client.request(this.path(), { method: 'POST', body: options });
  }

  list(options: { limit?: number; offset?: number; ownerUserId?: string } = {}): Promise<ApiResult<{ threads: AiThread[]; total: number }>> {
    return this.client.request(this.path(query(options)));
  }

  get(id: string): Promise<ApiResult<AiThread>> {
    return this.from(id).get();
  }

  delete(id: string): Promise<ApiResult<{ deleted: boolean }>> {
    return this.from(id).delete();
  }
}

export interface AiTrace {
  id: string;
  request_id: string | null;
  thread_id: string | null;
  caller: string;
  kind: 'chat' | 'embed';
  end_user_id: string | null;
  provider: string;
  model: string;
  key_source: 'byok' | 'platform';
  prompt_hash: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number | null;
  latency_ms: number;
  status: 'ok' | 'error';
  error: string | null;
  created_at: string;
}

function query(o: Record<string, unknown>): string {
  const q = Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return q.length ? `?${q.join('&')}` : '';
}
