import type { HttpClient } from './client';
import type { ApiResult } from '../types';

export interface EnvironmentVariable {
  name: string;
  value: string;
  description?: string;
  isSecret?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export class EnvironmentClient {
  constructor(private client: HttpClient) {}

  private get basePath(): string {
    return `/api/projects/${this.client.getProjectSlug()}/environment-variables`;
  }

  /**
   * List all environment variables
   */
  async list(): Promise<ApiResult<EnvironmentVariable[]>> {
    return this.client.request<EnvironmentVariable[]>(this.basePath);
  }

  /**
   * Get a specific environment variable
   */
  async get(name: string): Promise<ApiResult<EnvironmentVariable>> {
    return this.client.request<EnvironmentVariable>(`${this.basePath}/${encodeURIComponent(name)}`);
  }

  /**
   * Create or update an environment variable
   */
  async set(
    name: string,
    value: string,
    options: { description?: string; isSecret?: boolean } = {}
  ): Promise<ApiResult<EnvironmentVariable>> {
    return this.client.request<EnvironmentVariable>(`${this.basePath}/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: {
        value,
        description: options.description,
        is_secret: options.isSecret,
      },
    });
  }

  /**
   * Create a new environment variable
   */
  async create(
    name: string,
    value: string,
    options: { description?: string; isSecret?: boolean } = {}
  ): Promise<ApiResult<EnvironmentVariable>> {
    return this.client.request<EnvironmentVariable>(this.basePath, {
      method: 'POST',
      body: {
        name,
        value,
        description: options.description,
        is_secret: options.isSecret,
      },
    });
  }

  /**
   * Bulk create environment variables
   */
  async bulkCreate(
    variables: Array<{ name: string; value: string; description?: string; isSecret?: boolean }>
  ): Promise<ApiResult<EnvironmentVariable[]>> {
    return this.client.request<EnvironmentVariable[]>(`${this.basePath}/bulk`, {
      method: 'POST',
      body: { variables },
    });
  }

  /**
   * Delete an environment variable
   */
  async delete(name: string): Promise<ApiResult<{ success: boolean }>> {
    return this.client.request<{ success: boolean }>(`${this.basePath}/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
  }
}
