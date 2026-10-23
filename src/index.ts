import { HttpClient } from './lib/client';
import { DatabaseClient } from './lib/database';
import { FunctionsClient } from './lib/functions';
import { JobsClient } from './lib/jobs';
import { AuthClient } from './lib/auth';
import { LoggingClient } from './lib/logging';
import { EnvironmentClient } from './lib/environment';
import { StorageClient } from './lib/storage';
import { RealtimeClient } from './lib/realtime';
import { AnalyticsClient } from './lib/analytics';
import { AiClient } from './lib/ai';
import { MemoryClient, CollectionsClient } from './lib/ai-data';
import type { OrbitNestConfig } from './types';
import type { RealtimeOptions } from './lib/realtime';
import { type StorageAdapter, localStorageAdapter, memoryAdapter, createLocalStorageAdapter, createMemoryAdapter } from './lib/storage-adapters';

export * from './types';
export * from './lib/logging';
export * from './lib/environment';
export * from './lib/storage';
export * from './lib/realtime';
export * from './lib/analytics';
export * from './lib/ai';
export * from './lib/ai-data';
export { generateTypes, type GenerateTypesOptions } from './lib/typegen';
export { validatePath, sanitizePath, validateRequired } from './lib/validation';
export { OrbitNestError, unwrap, AuthLimitCodes } from './lib/errors';
export { isMfaChallenge, type MfaChallenge, type MfaFactor } from './lib/auth';
export {
  type StorageAdapter,
  localStorageAdapter,
  memoryAdapter,
  createLocalStorageAdapter,
  createMemoryAdapter,
};

const DEFAULT_BASE_URL = 'https://api.orbitnest.io';

/**
 * Decode the `project_slug` claim from an OrbitNest API key (JWT).
 *
 * The signing key isn't needed — we only read the payload to look up which
 * project the key belongs to. Throws when the token isn't a JWT or doesn't
 * carry a `project_slug` claim, which signals a misconfigured key.
 */
function decodeProjectSlugFromJwt(token: string): string {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('OrbitNest: apiKey is not a valid JWT (expected 3 segments)');
  }
  let payload = parts[1];
  // base64url → base64 padding
  payload = payload.replace(/-/g, '+').replace(/_/g, '/');
  switch (payload.length % 4) {
    case 2: payload += '=='; break;
    case 3: payload += '='; break;
  }
  let json: Record<string, unknown>;
  try {
    // Browsers expose `atob`; Node (for SSR/isomorphic use) exposes `Buffer`.
    const decoded = typeof atob !== 'undefined'
      ? atob(payload)
      : Buffer.from(payload, 'base64').toString('utf8');
    json = JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    throw new Error('OrbitNest: could not decode apiKey JWT payload');
  }
  const slug = json['project_slug'];
  if (typeof slug !== 'string' || slug.length === 0) {
    throw new Error('OrbitNest: apiKey JWT does not contain a project_slug claim');
  }
  return slug;
}

export interface OrbitNestClient {
  db: DatabaseClient;
  functions: FunctionsClient;
  /** @deprecated Needs a Studio admin token; every call returns an `ADMIN_ONLY` error. */
  jobs: JobsClient;
  auth: AuthClient;
  /** @deprecated Needs a Studio admin token; every call returns an `ADMIN_ONLY` error. */
  logs: LoggingClient;
  /** @deprecated Needs a Studio admin token; every call returns an `ADMIN_ONLY` error. */
  env: EnvironmentClient;
  storage: StorageClient;
  analytics: AnalyticsClient;
  /** AI Gateway: chat, streaming and embeddings with the project's own provider keys; `ai.threads` for conversations. */
  ai: AiClient;
  /** Memory API: facts about a user or agent, with semantic search. */
  memory: MemoryClient;
  /** Vector collections: ingest documents, hybrid search. */
  collections: CollectionsClient;
  /**
   * Create a realtime channel for live DB-change subscriptions and broadcasts.
   *
   * ```ts
   * const ch = client.channel('orders')
   *   .on('postgres_changes',
   *     { event: 'INSERT', table: 'orders', filter: { user_id: { eq: userId } } },
   *     (e) => console.log('new order', e.new))
   *   .subscribe();
   * ```
   *
   * In the browser this uses the native `WebSocket`. For isomorphic/SSR use on
   * Node.js < 22, pass a constructor: `realtimeOptions: { WebSocket }`.
   */
  channel: (name: string) => ReturnType<RealtimeClient['channel']>;
  /** Direct access to the underlying RealtimeClient. */
  realtime: RealtimeClient;
}

/**
 * Create an OrbitNest client for the **browser** (and other DOM/fetch
 * environments).
 *
 * Only `apiKey` is required — the project slug is decoded from the API key's
 * JWT payload and `baseUrl` defaults to `https://api.orbitnest.io`.
 *
 * Pass a `storage` adapter to persist the auth session across page loads
 * (`localStorageAdapter` keeps users signed in after a refresh; the default is
 * in-memory). Use a **publishable anon key** in client-side code — never a
 * service-role key.
 *
 * ```ts
 * import { createClient, localStorageAdapter } from '@orbitneststudio/js';
 *
 * const orbit = createClient({
 *   apiKey: import.meta.env.VITE_ORBITNEST_ANON_KEY,
 *   storage: localStorageAdapter, // keep the session after refresh
 * });
 *
 * const { data, error } = await orbit.db.from('posts').eq('published', true).select();
 * ```
 */
export function createClient(
  config: OrbitNestConfig & { realtimeOptions?: RealtimeOptions; storage?: StorageAdapter },
): OrbitNestClient {
  if (!config.apiKey) {
    throw new Error('OrbitNest: apiKey is required');
  }

  // Resolve projectSlug: caller override → JWT payload claim
  const projectSlug = config.projectSlug ?? decodeProjectSlugFromJwt(config.apiKey);
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');

  const httpClient = new HttpClient({ ...config, projectSlug, baseUrl });

  // The project slug is not a secret, so it stays in the URL query string.
  // The apiKey is a credential and must NOT appear in the URL, where it would
  // leak into proxy/CDN access logs, APM traces, and browser history. It is
  // passed to RealtimeClient and sent on the WS handshake via subprotocol (the
  // only credential channel a browser WebSocket allows).
  const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/realtime/v1/ws?project=${encodeURIComponent(projectSlug)}`;
  const auth = new AuthClient(httpClient, { storage: config.storage });
  // Data, storage and function calls run as the signed-in user (RLS
  // `auth.uid()`), refreshing the access token shortly before it expires.
  httpClient.setAccessTokenProvider(() => auth.getAccessToken(), (stale) => auth.refreshAccessToken(stale));

  // An explicit realtimeOptions.userJwt wins; otherwise realtime follows auth.
  const followAuth = !config.realtimeOptions?.userJwt;
  const realtimeClient = new RealtimeClient(wsUrl, {
    ...config.realtimeOptions,
    apiKey: config.apiKey,
    ...(followAuth
      ? {
          accessToken: () => auth.getAccessToken(),
          // A refresh notifies onAuthStateChange → setAuth, which reconnects.
          onAuthRejected: (stale: string) => { void auth.refreshAccessToken(stale); },
        }
      : {}),
  });
  if (followAuth) auth.onAuthStateChange((s) => realtimeClient.setAuth(s?.access_token ?? null));

  const db = new DatabaseClient(httpClient);

  return {
    db,
    functions: new FunctionsClient(httpClient),
    jobs: new JobsClient(httpClient),
    auth,
    logs: new LoggingClient(httpClient),
    env: new EnvironmentClient(httpClient),
    storage: new StorageClient(httpClient),
    channel: (name: string) => realtimeClient.channel(name),
    realtime: realtimeClient,
    analytics: new AnalyticsClient(httpClient),
    ai: new AiClient(httpClient),
    memory: new MemoryClient(httpClient),
    collections: new CollectionsClient(httpClient),
  };
}

export {
  HttpClient, DatabaseClient, FunctionsClient, JobsClient,
  AuthClient, LoggingClient, EnvironmentClient, StorageClient,
  RealtimeClient, AnalyticsClient,
};
