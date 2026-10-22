import type { OrbitNestConfig, RequestOptions, ApiResult, ApiError } from '../types';

// Internal config — by the time it reaches the HttpClient the slug has been
// resolved (decoded from JWT or supplied by the caller), so it's required.
type ResolvedConfig = Omit<OrbitNestConfig, 'projectSlug'> & { projectSlug: string };

export class HttpClient {
  private baseUrl: string;
  private apiKey: string;
  private projectSlug: string;
  private timeout: number;
  private analyticsToken: string | undefined;
  private clientIp: string | undefined;
  private accessTokenProvider?: () => Promise<string | null>;
  private tokenRefresher?: (staleToken: string) => Promise<string | null>;

  constructor(config: ResolvedConfig) {
    this.baseUrl = (config.baseUrl || 'https://api.orbitnest.io').replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.projectSlug = config.projectSlug;
    this.timeout = config.timeout || 30000;
    this.analyticsToken = config.analyticsToken;
    this.clientIp = config.clientIp;
  }

  getProjectSlug(): string {
    return this.projectSlug;
  }

  /** Configured API origin (e.g. `https://api.orbitnest.io`) without trailing slash. */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /** Default request timeout in ms. */
  getTimeout(): number {
    return this.timeout;
  }

  /** API key (used by storage methods that bypass the JSON request helper). */
  getApiKey(): string {
    return this.apiKey;
  }

  /**
   * Supply the signed-in user's access token (or null). `createClient` wires
   * this to the AuthClient so data, storage and function calls run as the user.
   * `refresh` is called once when the API rejects that token (401); it returns
   * a fresh token (or null when the session can't be renewed).
   */
  setAccessTokenProvider(
    fn: () => Promise<string | null>,
    refresh?: (staleToken: string) => Promise<string | null>,
  ): void {
    this.accessTokenProvider = fn;
    this.tokenRefresher = refresh;
  }

  /**
   * Credential headers for a project request. `apikey` always carries the
   * project key; `Authorization` carries the user's access token when signed
   * in (the project key otherwise). Matches the API's ApiKeyGuard precedence.
   */
  async authHeaders(): Promise<Record<string, string>> {
    return this.headersFor(this.accessTokenProvider ? await this.accessTokenProvider() : null);
  }

  /**
   * `fetch` with project credentials ahead of `init.headers`. As the user
   * (`asUser`), a 401 for the user token refreshes the session and retries
   * once; a second 401 is returned as-is (never a sign-out by itself).
   */
  async authFetch(
    url: string,
    init: RequestInit & { headers?: Record<string, string> },
    asUser = true,
  ): Promise<Response> {
    const token = asUser && this.accessTokenProvider ? await this.accessTokenProvider() : null;
    const send = (t: string | null) => fetch(url, { ...init, headers: { ...this.headersFor(t), ...init.headers } });
    const res = await send(token);
    if (res.status !== 401 || !token || !this.tokenRefresher) return res;
    const fresh = await this.tokenRefresher(token);
    if (!fresh || fresh === token) return res;
    await res.body?.cancel().catch(() => {});
    // FormData / string bodies are re-sendable; a one-shot stream would not be.
    return send(fresh);
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
    return this._fetch<T>(path, options, true);
  }

  /**
   * Same as `request()` but never attaches the user session, only the project
   * key. Auth endpoints (sign-in, refresh, …) use it so refreshing a session
   * can't recurse into itself.
   */
  async requestPublic<T>(path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
    return this._fetch<T>(path, options, false);
  }

  /** Analytics-specific request — adds `x-analytics-token` header when configured. */
  async requestForAnalytics<T>(path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
    const extraHeaders = this.analyticsToken
      ? { 'x-analytics-token': this.analyticsToken }
      : undefined;
    return this._fetch<T>(path, { ...options, headers: { ...extraHeaders, ...options.headers } }, false);
  }

  /**
   * Same as `request()` but sends the supplied user access token as the
   * Bearer auth header. Used for endpoints that authenticate as a project
   * user (e.g. passkey device management).
   */
  async requestWithToken<T>(
    path: string,
    accessToken: string,
    options: RequestOptions = {},
  ): Promise<ApiResult<T>> {
    return this._fetch<T>(path, { ...options, headers: { Authorization: `Bearer ${accessToken}`, ...options.headers } }, false);
  }

  private headersFor(token: string | null): Record<string, string> {
    return {
      apikey: this.apiKey,
      Authorization: `Bearer ${token || this.apiKey}`,
      ...(this.clientIp ? { 'X-OrbitNest-Client-IP': this.clientIp } : {}),
    };
  }

  private async _fetch<T>(
    path: string,
    options: RequestOptions,
    asUser: boolean,
  ): Promise<ApiResult<T>> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeout || this.timeout);

    try {
      const response = await this.authFetch(url, {
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
        keepalive: options.keepalive,
        // Fail loudly on unexpected redirects rather than silently forwarding
        // the Bearer credential to the redirect target.
        redirect: 'error',
      }, asUser);

      clearTimeout(timeoutId);

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        return {
          data: null,
          error: {
            message: errorMessage(data, response.status),
            code: data?.code || data?.statusCode?.toString(),
            status: response.status,
            // Structured fields, e.g. QUOTA_EXCEEDED's quota/plan/limit/usage.
            details: data ?? undefined,
          },
        };
      }

      return { data: data as T, error: null };
    } catch (err) {
      clearTimeout(timeoutId);

      if (err instanceof Error && err.name === 'AbortError') {
        return {
          data: null,
          error: { message: 'Request timeout', code: 'TIMEOUT' },
        };
      }

      return {
        data: null,
        error: {
          message: err instanceof Error ? err.message : 'Unknown error',
          code: 'NETWORK_ERROR',
        },
      };
    }
  }
}

/** Readable message from an API error body (NestJS validation sends `message: string[]`). */
export function errorMessage(body: unknown, status: number, fallback?: string): string {
  const b = body as { message?: unknown; error?: unknown } | null;
  const m = b?.message ?? b?.error;
  if (Array.isArray(m)) return m.join('; ');
  if (typeof m === 'string' && m) return m;
  const nested = (m as { message?: unknown } | null)?.message;
  if (typeof nested === 'string' && nested) return nested;
  return fallback ?? `Request failed with status ${status}`;
}

/**
 * `jobs`, `env` and `logs` map to Studio-admin routes (admin JWT + project
 * UUID, owner only). A project anon/service key can never call them, so these
 * clients fail fast instead of sending a request that always 401s.
 */
export function adminOnlyError(feature: string): ApiError {
  return {
    data: null,
    error: {
      message:
        `OrbitNest: ${feature} requires a Studio admin token and is not available with a project API key. ` +
        'Manage it in OrbitNest Studio, the OrbitNest CLI or the MCP server.',
      code: 'ADMIN_ONLY',
    },
  };
}
