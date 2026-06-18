// ─────────────────────────────────────────────────────────────────────────────
// OrbitNest Realtime — Node SDK
// Provides a Supabase-compatible channel API over a native WebSocket.
// ─────────────────────────────────────────────────────────────────────────────

export type RealtimeStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

// ─── Presence types ────────────────────────────────────────────────────────────

export type PresenceState = Record<string, any[]>;
export type PresenceSyncCallback = (state: PresenceState) => void;
export type PresenceJoinCallback = (key: string, presences: any[]) => void;
export type PresenceLeaveCallback = (key: string, presences: any[]) => void;

export type PgEvent = 'INSERT' | 'UPDATE' | 'DELETE' | '*';

export interface PgChangesPayload {
  op: 'INSERT' | 'UPDATE' | 'DELETE';
  schema: string;
  table: string;
  new?: Record<string, unknown>;
  old?: Record<string, unknown>;
  commit_ts: string;
}

export interface BroadcastPayload {
  event: string;
  payload: unknown;
}

export interface PgChangesFilter {
  event: PgEvent | PgEvent[];
  schema?: string;
  table: string;
  filter?: Record<string, FilterValue>;
}

export interface FilterValue {
  eq?: string | number;
  neq?: string | number;
  in?: Array<string | number>;
  gt?: number | string;
  lt?: number | string;
  like?: string;
}

type PgCallback = (payload: PgChangesPayload) => void;
type BroadcastCallback = (payload: BroadcastPayload) => void;
type StatusCallback = (status: RealtimeStatus, err?: Error) => void;

interface ChannelHandler {
  type: 'postgres_changes' | 'broadcast';
  opts: PgChangesFilter | { event: string };
  callback: PgCallback | BroadcastCallback;
}

// ─── PresenceManager ─────────────────────────────────────────────────────────

/**
 * Presence API attached to a broadcast channel.  Tracks who is currently
 * online and fires join/leave callbacks when the roster changes.
 *
 * ```ts
 * const ch = client.channel('room')
 * ch.presence
 *   .onSync((state) => console.log('roster', state))
 *   .onJoin((key, list) => console.log('joined', key, list))
 *   .onLeave((key, list) => console.log('left', key, list))
 * await ch.subscribe()
 * await ch.presence.track({ name: 'Alice' })
 * ```
 */
export class PresenceManager {
  private state: PresenceState = {};
  private syncCbs: PresenceSyncCallback[] = [];
  private joinCbs: PresenceJoinCallback[] = [];
  private leaveCbs: PresenceLeaveCallback[] = [];

  constructor(
    private readonly channelName: string,
    private readonly client: RealtimeClient,
  ) {}

  /** Send presence state to the server; triggers a `presence.state` fan-out. */
  async track(state: Record<string, any>): Promise<void> {
    await this.client['sendPresenceTrack'](this.channelName, state);
  }

  /**
   * Stop tracking presence on this channel.  Other clients will see the
   * departure in their next `presence.state` message.
   */
  async untrack(): Promise<void> {
    this.client['sendPresenceUntrack'](this.channelName);
  }

  /** Returns a shallow copy of the last-known presence roster. */
  getState(): PresenceState { return { ...this.state }; }

  /** Register a callback fired on every full roster sync. */
  onSync(cb: PresenceSyncCallback): this { this.syncCbs.push(cb); return this; }

  /** Register a callback fired when a new socket joins the channel. */
  onJoin(cb: PresenceJoinCallback): this { this.joinCbs.push(cb); return this; }

  /** Register a callback fired when a socket leaves the channel. */
  onLeave(cb: PresenceLeaveCallback): this { this.leaveCbs.push(cb); return this; }

  // ─── Internal ───────────────────────────────────────────────────────────────

  _handleStateUpdate(newState: PresenceState): void {
    const prev = this.state;

    // Detect joins (keys present in new but not in prev)
    for (const [key, presences] of Object.entries(newState)) {
      if (!prev[key]) {
        for (const cb of this.joinCbs) cb(key, presences);
      }
    }

    // Detect leaves (keys present in prev but not in new)
    for (const [key, presences] of Object.entries(prev)) {
      if (!newState[key]) {
        for (const cb of this.leaveCbs) cb(key, presences);
      }
    }

    this.state = { ...newState };
    for (const cb of this.syncCbs) cb({ ...this.state });
  }
}

// ─── RealtimeChannel ──────────────────────────────────────────────────────────

export class RealtimeChannel {
  private handlers: ChannelHandler[] = [];
  private statusCb?: StatusCallback;
  private subscribed = false;

  /** Presence API for this channel. */
  readonly presence: PresenceManager;

  constructor(
    private readonly name: string,
    private readonly client: RealtimeClient,
  ) {
    this.presence = new PresenceManager(name, client);
  }

  /**
   * Register a handler for Postgres row-level changes.
   *
   * ```ts
   * ch.on('postgres_changes',
   *   { event: 'INSERT', table: 'orders', filter: { user_id: { eq: 'abc' } } },
   *   (e) => console.log(e))
   * ```
   */
  on(type: 'postgres_changes', opts: PgChangesFilter, cb: PgCallback): this;
  on(type: 'broadcast', opts: { event: string }, cb: BroadcastCallback): this;
  on(type: string, opts: any, cb: any): this {
    this.handlers.push({ type: type as any, opts, callback: cb });
    return this;
  }

  /**
   * Subscribe.  The optional callback receives status transitions.
   *
   * ```ts
   * ch.subscribe((status, err) => console.log(status, err));
   * ```
   */
  subscribe(cb?: StatusCallback): this {
    this.statusCb = cb;
    this.client['registerChannel'](this);
    return this;
  }

  /** Send a broadcast message on this channel. */
  async send(event: string, payload: unknown): Promise<void> {
    await this.client['sendBroadcast'](this.name, event, payload);
  }

  /** Unsubscribe and remove the channel. */
  async unsubscribe(): Promise<void> {
    await this.client['unregisterChannel'](this.name);
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  get channelName(): string { return this.name; }

  /** Called by RealtimeClient when the WS is ready — sends subscribe messages. */
  _activate(ws: WebSocketLike): void {
    for (const h of this.handlers) {
      if (h.type === 'postgres_changes') {
        const opts = h.opts as PgChangesFilter;
        const schema = opts.schema ?? 'public';
        const events = normaliseEvents(opts.event);
        ws.send(JSON.stringify({
          id: `${this.name}-${Math.random().toString(36).slice(2)}`,
          type: 'subscribe',
          channel: `table:${schema}.${opts.table}`,
          events,
          filter: opts.filter,
        }));
      } else if (h.type === 'broadcast') {
        // Subscribe to the broadcast channel (no DB trigger needed)
        ws.send(JSON.stringify({
          id: `${this.name}-bc-${Math.random().toString(36).slice(2)}`,
          type: 'subscribe',
          channel: `broadcast:${this.name}`,
        }));
      }
    }
    this.subscribed = true;
    this.statusCb?.('connected');
  }

  _setStatus(status: RealtimeStatus, err?: Error): void {
    this.statusCb?.(status, err);
  }

  /** Route an inbound server message to matching handlers. */
  _dispatch(msg: Record<string, any>): void {
    if (msg.type === 'db_event') {
      const payload: PgChangesPayload = {
        op: msg.op,
        schema: msg.schema,
        table: msg.table,
        new: msg.new,
        old: msg.old,
        commit_ts: msg.commit_ts,
      };
      for (const h of this.handlers) {
        if (h.type !== 'postgres_changes') continue;
        const opts = h.opts as PgChangesFilter;
        const events = normaliseEvents(opts.event);
        if (!events.includes(msg.op) && !events.includes('*')) continue;
        if (opts.table && opts.table !== msg.table) continue;
        if (opts.schema && opts.schema !== msg.schema) continue;
        (h.callback as PgCallback)(payload);
      }
    } else if (msg.type === 'broadcast') {
      const payload: BroadcastPayload = { event: msg.event, payload: msg.payload };
      for (const h of this.handlers) {
        if (h.type !== 'broadcast') continue;
        const opts = h.opts as { event: string };
        if (opts.event !== '*' && opts.event !== msg.event) continue;
        (h.callback as BroadcastCallback)(payload);
      }
    } else if (msg.type === 'presence.state') {
      this.presence._handleStateUpdate((msg.presences as PresenceState) ?? {});
    }
  }
}

// ─── RealtimeClient ───────────────────────────────────────────────────────────

export interface RealtimeOptions {
  /** Override with a custom WebSocket constructor (e.g. the 'ws' package on
   *  older Node versions).  Defaults to globalThis.WebSocket. */
  WebSocket?: WebSocketConstructor;
  /** Optional project-user JWT for RLS-scoped subscriptions. */
  userJwt?: string;
  /**
   * Project API key. Sent on the handshake via a WS subprotocol token and an
   * Authorization header — never in the URL query string (it is a credential
   * that would otherwise leak into proxy/CDN logs and browser history).
   */
  apiKey?: string;
}

// `protocols` covers both browser WebSocket and the `ws` package's
// `(url, protocols)` signature. `options` is the optional third argument that
// the `ws` package accepts for handshake-level config (e.g. custom `headers`);
// browser WebSocket ignores it, so it is best-effort for header transport.
type WebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
  options?: { headers?: Record<string, string> },
) => WebSocketLike;

interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: any) => any) | null;
  onclose: ((ev: any) => any) | null;
  onerror: ((ev: any) => any) | null;
  onmessage: ((ev: any) => any) | null;
}

const CONNECTING = 0;
const OPEN = 1;

/** Initial reconnect delay under normal conditions. */
const BASE_RECONNECT_DELAY_MS = 1_000;
/** Floor delay when the server closes us for rate-limiting / policy reasons. */
const RATE_LIMITED_RECONNECT_DELAY_MS = 10_000;
/** Absolute upper bound on exponential backoff. */
const MAX_RECONNECT_DELAY_MS = 60_000;
/** WS close code the gateway uses when a socket is closed for rate limiting. */
const WS_CLOSE_RATE_LIMITED = 4029;

export class RealtimeClient {
  private ws: WebSocketLike | null = null;
  private channels = new Map<string, RealtimeChannel>();
  private reconnectDelay = BASE_RECONNECT_DELAY_MS;
  private maxReconnectDelay = MAX_RECONNECT_DELAY_MS;
  private shouldReconnect = true;
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    private readonly options: RealtimeOptions = {},
  ) {}

  /** Get or create a channel.  Call `.on()` then `.subscribe()` on the result. */
  channel(name: string): RealtimeChannel {
    if (!this.channels.has(name)) {
      this.channels.set(name, new RealtimeChannel(name, this));
    }
    return this.channels.get(name)!;
  }

  /** Tear down all channels and close the WebSocket. */
  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close(1000, 'client disconnect');
    this.ws = null;
    this.channels.clear();
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  private connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    if (this.ws?.readyState === OPEN) return Promise.resolve();

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const WS: WebSocketConstructor =
        this.options.WebSocket ?? (globalThis as any).WebSocket;

      if (!WS) {
        reject(new Error(
          'No WebSocket implementation found. ' +
          'On Node.js < 22, pass a WebSocket constructor via options.WebSocket ' +
          '(e.g. from the "ws" package).',
        ));
        return;
      }

      const protocols: string[] = ['orbitnest-realtime-v1'];
      if (this.options.userJwt) {
        protocols.push(`orbitnest.user-jwt.${this.options.userJwt}`);
      }
      // Carry the project API key on the handshake instead of in the URL query
      // string (which leaks into proxy/CDN access logs and browser history).
      // We send it via BOTH a subprotocol token AND an Authorization header to
      // maximize server-side compatibility: subprotocols work in every
      // environment (browsers can't set handshake headers), while the
      // Authorization header is honored by the `ws` package's handshake options.
      let handshakeOptions: { headers?: Record<string, string> } | undefined;
      if (this.options.apiKey) {
        protocols.push(`orbitnest.apikey.${this.options.apiKey}`);
        handshakeOptions = { headers: { Authorization: `Bearer ${this.options.apiKey}` } };
      }

      const ws = new WS(this.url, protocols, handshakeOptions);

      ws.onopen = () => {
        this.reconnectDelay = BASE_RECONNECT_DELAY_MS;
        this.connectPromise = null;
        // Activate all pending channels
        for (const ch of this.channels.values()) ch._activate(ws);
        resolve();
      };

      ws.onmessage = (ev: any) => {
        try {
          const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
          this.route(msg);
        } catch { /* ignore malformed */ }
      };

      ws.onerror = (ev: any) => {
        const err = new Error(ev?.message ?? 'WebSocket error');
        for (const ch of this.channels.values()) ch._setStatus('error', err);
        this.connectPromise = null;
        reject(err);
      };

      ws.onclose = (ev: any) => {
        this.connectPromise = null;
        for (const ch of this.channels.values()) ch._setStatus('disconnected');

        // Inspect close code to decide backoff floor.
        const code: number | undefined = ev?.code;
        // 1000 (normal) + 1001 (going away) and auth-failed (4001) → do not reconnect.
        if (code === 1000 || code === 1001 || code === 4001) {
          this.shouldReconnect = false;
        }

        if (this.shouldReconnect) {
          // If the server closed us for rate limiting / policy violation, jump to
          // a much longer base delay so we don't create a reconnect storm.
          if (
            code === WS_CLOSE_RATE_LIMITED ||
            code === 1008 ||
            code === 1013
          ) {
            this.reconnectDelay = Math.max(
              this.reconnectDelay,
              RATE_LIMITED_RECONNECT_DELAY_MS,
            );
          }

          // Add small jitter so many clients don't all reconnect at the same ms.
          const jitter = Math.floor(Math.random() * 500);
          const delay = Math.min(this.reconnectDelay + jitter, this.maxReconnectDelay);
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => this.reconnect(), delay);
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
        }
      };

      this.ws = ws;
    });

    return this.connectPromise;
  }

  private reconnect(): void {
    this.reconnectTimer = null;
    this.connectPromise = null;
    this.ws = null;
    if (this.shouldReconnect && this.channels.size > 0) {
      this.connect().catch(() => {});
    }
  }

  private route(msg: Record<string, any>): void {
    if (msg.type === 'db_event') {
      // Match by the full channel name stored in the channel instance
      for (const ch of this.channels.values()) {
        ch._dispatch(msg);
      }
    } else if (msg.type === 'broadcast') {
      for (const ch of this.channels.values()) {
        if (`broadcast:${ch.channelName}` === msg.channel) {
          ch._dispatch(msg);
        }
      }
    } else if (msg.type === 'presence.state') {
      // Route to the channel whose broadcast channel matches.
      const channelName = (msg.channel as string | undefined)?.replace(/^broadcast:/, '');
      if (channelName) {
        const ch = this.channels.get(channelName);
        if (ch) ch._dispatch(msg);
      }
    }
    // 'subscribed', 'system', 'error' messages — no-op for now
  }

  private registerChannel(ch: RealtimeChannel): void {
    this.channels.set(ch.channelName, ch);
    ch._setStatus('connecting');
    this.connect()
      .then(() => {
        if (this.ws?.readyState === OPEN) ch._activate(this.ws!);
      })
      .catch((err) => ch._setStatus('error', err));
  }

  private async unregisterChannel(name: string): Promise<void> {
    const ch = this.channels.get(name);
    if (!ch) return;
    if (this.ws?.readyState === OPEN) {
      this.ws.send(JSON.stringify({
        id: `unsub-${Math.random().toString(36).slice(2)}`,
        type: 'unsubscribe',
        channel: name,
      }));
    }
    this.channels.delete(name);
    if (this.channels.size === 0) {
      this.ws?.close(1000, 'no channels');
    }
  }

  private async sendBroadcast(channelName: string, event: string, payload: unknown): Promise<void> {
    await this.connect();
    if (this.ws?.readyState !== OPEN) throw new Error('Not connected');
    this.ws.send(JSON.stringify({
      id: `bc-${Math.random().toString(36).slice(2)}`,
      type: 'broadcast',
      channel: `broadcast:${channelName}`,
      event,
      payload,
    }));
  }

  private async sendPresenceTrack(
    channelName: string,
    state: Record<string, any>,
  ): Promise<void> {
    await this.connect();
    if (this.ws?.readyState !== OPEN) throw new Error('Not connected');
    this.ws.send(JSON.stringify({
      id: `pt-${Math.random().toString(36).slice(2)}`,
      type: 'presence.track',
      channel: `broadcast:${channelName}`,
      state,
    }));
  }

  private sendPresenceUntrack(channelName: string): void {
    if (this.ws?.readyState === OPEN) {
      this.ws.send(JSON.stringify({
        id: `pu-${Math.random().toString(36).slice(2)}`,
        type: 'unsubscribe',
        channel: `broadcast:${channelName}`,
      }));
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normaliseEvents(event: PgEvent | PgEvent[]): string[] {
  if (event === '*') return ['INSERT', 'UPDATE', 'DELETE'];
  return Array.isArray(event) ? event : [event];
}
