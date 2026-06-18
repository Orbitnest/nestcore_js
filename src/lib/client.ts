import type { OrbitNestConfig, RequestOptions, ApiResult } from '../types';

// Internal config — by the time it reaches the HttpClient the slug has been
// resolved (decoded from JWT or supplied by the caller), so it's required.
type ResolvedConfig = Omit<OrbitNestConfig, 'projectSlug'> & { projectSlug: string };

export class HttpClient {
  private baseUrl: string;
  private apiKey: string;
  private projectSlug: string;
  private timeout: number;
  private analyticsToken: string | undefined;

  constructor(config: ResolvedConfig) {
    this.baseUrl = (config.baseUrl || 'https://api.orbitnest.io').replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.projectSlug = config.projectSlug;
    this.timeout = config.timeout || 30000;
    this.analyticsToken = config.analyticsToken;
  }

  getProjectSlug(): string {
    return this.projectSlug;
  }

  /** Configured API origin (e.g. `https://api.orbitnest.io`) without trailing slash. */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /** API key (used by storage methods that bypass the JSON request helper). */
  getApiKey(): string {
    return this.apiKey;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
    return this._fetch<T>(path, this.apiKey, options);
  }

  /** Analytics-specific request — adds `x-analytics-token` header when configured. */
  async requestForAnalytics<T>(path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
    const extraHeaders = this.analyticsToken
      ? { 'x-analytics-token': this.analyticsToken }
      : undefined;
    return this._fetch<T>(path, this.apiKey, {
      ...options,
      headers: { ...extraHeaders, ...options.headers },
    });
  }

  /**
   * Same as `request()` but sends the supplied user access token as the
   * Bearer auth header instead of the project API key. Used for endpoints
   * that authenticate as a project user (e.g. passkey device management).
   */
  async requestWithToken<T>(
    path: string,
    accessToken: string,
    options: RequestOptions = {},
  ): Promise<ApiResult<T>> {
    return this._fetch<T>(path, accessToken, options);
  }

  private async _fetch<T>(
    path: string,
    bearer: string,
    options: RequestOptions,
  ): Promise<ApiResult<T>> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeout || this.timeout);

    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
          ...options.headers,
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
        // Fail loudly on unexpected redirects rather than silently forwarding
        // the Bearer credential to the redirect target.
        redirect: 'error',
      });

      clearTimeout(timeoutId);

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        return {
          data: null,
          error: {
            message: data?.message || data?.error || `Request failed with status ${response.status}`,
            code: data?.code || data?.statusCode?.toString(),
            status: response.status,
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
