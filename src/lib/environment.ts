import { adminOnlyError, type HttpClient } from './client';
import type { ApiResult } from '../types';

export interface EnvironmentVariable {
  name: string;
  value: string;
  description?: string;
  isSecret?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * @deprecated Not usable with a project API key: these routes need a NestCore console
 * admin token. Every method resolves to an `ADMIN_ONLY` error without calling
 * the API. Use the NestCore console, the CLI or the MCP server instead.
 */
export class EnvironmentClient {
  constructor(private client: HttpClient) {}

  /**
   * List all environment variables
   */
  async list(): Promise<ApiResult<EnvironmentVariable[]>> {
    return adminOnlyError('client.env');
  }

  /**
   * Get a specific environment variable
   */
  async get(name: string): Promise<ApiResult<EnvironmentVariable>> {
    return adminOnlyError('client.env');
  }

  /**
   * Create or update an environment variable
   */
  async set(
    name: string,
    value: string,
    options: { description?: string; isSecret?: boolean } = {}
  ): Promise<ApiResult<EnvironmentVariable>> {
    return adminOnlyError('client.env');
  }

  /**
   * Create a new environment variable
   */
  async create(
    name: string,
    value: string,
    options: { description?: string; isSecret?: boolean } = {}
  ): Promise<ApiResult<EnvironmentVariable>> {
    return adminOnlyError('client.env');
  }

  /**
   * Bulk create environment variables
   */
  async bulkCreate(
    variables: Array<{ name: string; value: string; description?: string; isSecret?: boolean }>
  ): Promise<ApiResult<EnvironmentVariable[]>> {
    return adminOnlyError('client.env');
  }

  /**
   * Delete an environment variable
   */
  async delete(name: string): Promise<ApiResult<{ success: boolean }>> {
    return adminOnlyError('client.env');
  }
}
