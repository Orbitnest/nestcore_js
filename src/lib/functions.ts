import type { HttpClient } from './client';
import type { FunctionInvokeOptions, FunctionResponse, ApiResult } from '../types';

export class FunctionsClient {
  constructor(private client: HttpClient) {}

  /**
   * Invoke an edge function
   */
  async invoke<T = unknown>(
    functionName: string,
    options: FunctionInvokeOptions = {}
  ): Promise<ApiResult<FunctionResponse<T>>> {
    const path = `/api/projects/${this.client.getProjectSlug()}/functions/v1/${encodeURIComponent(functionName)}`;

    const result = await this.client.request<T>(path, {
      method: options.method || 'POST',
      body: options.body,
      headers: options.headers,
    });

    if (result.error) {
      return result as ApiResult<FunctionResponse<T>>;
    }

    return {
      data: {
        data: result.data,
        status: 200,
        headers: {},
      },
      error: null,
    };
  }
}
