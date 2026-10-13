import { errorMessage, type HttpClient } from './client';
import type { FunctionInvokeOptions, FunctionResponse, ApiResult } from '../types';

export class FunctionsClient {
  constructor(private client: HttpClient) {}

  /**
   * Invoke an edge function. Runs as the signed-in user when there is a
   * session (fills `ctx.user`), otherwise with the project key.
   *
   * Returns the function's real `status` and `headers`. The body is parsed by
   * content type: JSON → object, `text/*` → string, anything else → Blob.
   * A non-2xx response is an error whose `details` holds the parsed body.
   */
  async invoke<T = unknown>(
    functionName: string,
    options: FunctionInvokeOptions = {}
  ): Promise<ApiResult<FunctionResponse<T>>> {
    const url = `${this.client.getBaseUrl()}/api/projects/${this.client.getProjectSlug()}/functions/v1/${encodeURIComponent(functionName)}`;
    const method = options.method || 'POST';
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.client.getTimeout());

    try {
      const response = await this.client.authFetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
        body: options.body !== undefined && method !== 'GET' ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
        // Never forward credentials to a redirect target.
        redirect: 'error',
      });
      clearTimeout(timeoutId);

      const contentType = response.headers.get('content-type') ?? '';
      const data: unknown = contentType.includes('json')
        ? await response.json().catch(() => null)
        : contentType.startsWith('text/')
          ? await response.text()
          : await response.blob();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => { headers[key] = value; });

      if (!response.ok) {
        return {
          data: null,
          error: {
            message: errorMessage(data, response.status),
            code: (data as { code?: string } | null)?.code,
            status: response.status,
            details: data,
          },
        };
      }
      return { data: { data: data as T, status: response.status, headers }, error: null };
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === 'AbortError') {
        return { data: null, error: { message: 'Request timeout', code: 'TIMEOUT' } };
      }
      return {
        data: null,
        error: { message: err instanceof Error ? err.message : 'Unknown error', code: 'NETWORK_ERROR' },
      };
    }
  }
}
