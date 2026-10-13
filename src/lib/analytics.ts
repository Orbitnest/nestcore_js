import type { HttpClient } from './client';
import type { ApiResult } from '../types';

type Platform = 'node' | 'web' | 'react-native' | 'unknown';

export interface AnalyticsEvent {
  event_id: string;
  event: string;
  anonymous_id: string;
  platform: Platform;
  timestamp: string;
  session_id?: string;
  user_id?: string;
  app_id?: string;
  sdk_version?: string;
  app_version?: string;
  properties?: Record<string, unknown>;
  device_info?: {
    model?: string;
    os?: string;
    os_version?: string;
    brand?: string;
    is_tablet?: boolean;
    locale?: string;
    timezone?: string;
    screen_width?: number;
    screen_height?: number;
  };
}

export interface IngestionResult {
  accepted: number;
  rejected: number;
  errors: Array<{ event_id: string; reason: string }>;
}

export interface AnalyticsOptions {
  platform?: Platform;
  appVersion?: string;
  flushInterval?: number;
  maxBatchSize?: number;
}

const MAX_BATCH_SIZE_CAP = 500;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_FLUSH_INTERVAL = 5000;
/** Cap on events kept for retry while the API is unreachable. */
const MAX_QUEUE = 1000;

// Persisted identity keys. In a browser the SDK is re-instantiated on every full
// page load, so generating a fresh anonymous_id per instance would count the same
// visitor as a brand-new user on every visit. Persist it in localStorage instead.
const ANON_STORAGE_KEY = 'orbitnest_anonymous_id';
const SESSION_ID_KEY = 'orbitnest_session_id';
const SESSION_TS_KEY = 'orbitnest_session_last_activity';
// 30 min of inactivity ends a session — matches analytics_projects.session_timeout_mins.
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

function generateUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID but with Web Crypto
  // (crypto.getRandomValues — available in Node >=18 and modern browsers).
  // Build an RFC 4122 v4 UUID from 16 cryptographically-strong random bytes
  // instead of the non-cryptographic, predictable Math.random().
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // Last-resort fallback for environments lacking Web Crypto entirely.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** A localStorage handle, but only if it's actually usable (private-mode and
 *  SSR both expose-or-throw). Returns null on the server or when blocked. */
function getLocalStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const probe = '__on_ls_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

/** Browser vs server — used to default the event platform when not specified. */
function detectPlatform(): Platform {
  return typeof window !== 'undefined' && typeof document !== 'undefined' ? 'web' : 'node';
}

/** Stable, long-lived per-browser anonymous id (created once, reused forever). */
function loadOrCreateAnonymousId(store: Storage | null): string {
  if (!store) return generateUuid();
  try {
    let id = store.getItem(ANON_STORAGE_KEY);
    if (!id) {
      id = generateUuid();
      store.setItem(ANON_STORAGE_KEY, id);
    }
    return id;
  } catch {
    return generateUuid();
  }
}

/** Current session id, rotating after SESSION_TIMEOUT_MS of inactivity and
 *  sliding the activity timestamp on every call. */
function resolveSessionId(store: Storage | null, fallback: string): string {
  if (!store) return fallback;
  try {
    const now = Date.now();
    const last = parseInt(store.getItem(SESSION_TS_KEY) ?? '0', 10) || 0;
    let sid = store.getItem(SESSION_ID_KEY);
    if (!sid || now - last > SESSION_TIMEOUT_MS) {
      sid = generateUuid();
      store.setItem(SESSION_ID_KEY, sid);
    }
    store.setItem(SESSION_TS_KEY, String(now));
    return sid;
  } catch {
    return fallback;
  }
}

export class AnalyticsClient {
  private readonly storage: Storage | null;
  private readonly anonymousId: string;
  private readonly fallbackSessionId: string;
  private readonly platform: Platform;
  private readonly appVersion: string | undefined;
  private readonly flushInterval: number;
  private readonly maxBatchSize: number;

  private userId: string | undefined;
  private queue: AnalyticsEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly client: HttpClient, options: AnalyticsOptions = {}) {
    this.storage = getLocalStorage();
    // anonymous_id persists across page loads (stable visitor); session_id rotates
    // on inactivity. On the server (no storage) both fall back to a per-instance uuid.
    this.anonymousId = loadOrCreateAnonymousId(this.storage);
    this.fallbackSessionId = generateUuid();
    this.platform = options.platform ?? detectPlatform();
    this.appVersion = options.appVersion;
    this.flushInterval = options.flushInterval ?? DEFAULT_FLUSH_INTERVAL;
    this.maxBatchSize = Math.min(options.maxBatchSize ?? DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE_CAP);

    // Browser: send what's queued when the page is hidden or unloaded, with
    // keepalive so the request outlives the page.
    if (typeof window !== 'undefined' && typeof document !== 'undefined' && window.addEventListener) {
      window.addEventListener('pagehide', () => this.flushInBackground(true));
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.flushInBackground(true);
      });
    }
  }

  identify(userId: string, traits?: Record<string, unknown>): void {
    this.userId = userId;
    this.enqueue('identify', traits);
  }

  track(event: string, properties?: Record<string, unknown>): void {
    this.enqueue(event, properties);
  }

  screen(screenName: string, properties?: Record<string, unknown>): void {
    this.enqueue('screen_view', { screen: screenName, ...properties });
  }

  crash(error: Error | string, properties?: Record<string, unknown>): void {
    const msg = error instanceof Error ? error.message : error;
    const stack = error instanceof Error ? error.stack : undefined;
    // Field names the crash grouper reads (error_type / error_message / stack_trace).
    this.enqueue('crash', {
      ...(error instanceof Error ? { error_type: error.name } : {}),
      error_message: msg,
      ...(stack ? { stack_trace: stack } : {}),
      ...properties,
    });
  }

  async flush(keepalive = false): Promise<ApiResult<IngestionResult>> {
    this.clearFlushTimer();

    if (this.queue.length === 0) {
      return { data: { accepted: 0, rejected: 0, errors: [] }, error: null };
    }

    const batch = this.queue.splice(0, this.queue.length);

    const result = await this.client.requestForAnalytics<IngestionResult>('/api/analytics/events', {
      method: 'POST',
      body: { events: batch },
      keepalive,
    });

    // Network errors, timeouts, 429 and 5xx are transient: keep the batch
    // (oldest first, capped) and try again on the next flush.
    const status = result.error?.status;
    if (result.error && (status === undefined || status === 429 || status >= 500)) {
      this.queue = [...batch, ...this.queue].slice(-MAX_QUEUE);
      if (!keepalive) this.scheduleFlush();
    }

    return result;
  }

  /** Flush from a timer/unload. Dropped events are logged, never thrown. */
  private flushInBackground(keepalive = false): void {
    void this.flush(keepalive).then((r) => {
      const status = r.error?.status;
      if (r.error && status !== undefined && status !== 429 && status < 500) {
        console.warn(`[orbitnest] analytics events rejected (${status}): ${r.error.message}`);
      }
    });
  }

  private enqueue(event: string, properties?: Record<string, unknown>): void {
    const entry: AnalyticsEvent = {
      event_id: generateUuid(),
      event,
      anonymous_id: this.anonymousId,
      platform: this.platform,
      timestamp: new Date().toISOString(),
      session_id: resolveSessionId(this.storage, this.fallbackSessionId),
      ...(this.userId ? { user_id: this.userId } : {}),
      ...(this.appVersion ? { app_version: this.appVersion } : {}),
      ...(properties ? { properties } : {}),
    };

    this.queue.push(entry);

    if (this.queue.length >= this.maxBatchSize) {
      this.flushInBackground();
    } else {
      this.scheduleFlush();
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushInBackground();
    }, this.flushInterval);
  }

  private clearFlushTimer(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
