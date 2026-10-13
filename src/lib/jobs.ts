import { adminOnlyError, type HttpClient } from './client';
import type {
  BackgroundJob,
  BackgroundJobRun,
  CreateJobOptions,
  UpdateJobOptions,
  ApiResult,
} from '../types';

/**
 * @deprecated Not usable with a project API key: these routes need a Studio
 * admin token. Every method resolves to an `ADMIN_ONLY` error without calling
 * the API. Use OrbitNest Studio, the CLI or the MCP server instead.
 */
export class JobsClient {
  constructor(private client: HttpClient) {}

  /**
   * Create a background job with a cron schedule.
   */
  async create(options: CreateJobOptions): Promise<ApiResult<BackgroundJob>> {
    return adminOnlyError('client.jobs');
  }

  /**
   * List all background jobs for the current project.
   */
  async list(): Promise<ApiResult<BackgroundJob[]>> {
    return adminOnlyError('client.jobs');
  }

  /**
   * Get a single background job by name.
   */
  async get(name: string): Promise<ApiResult<BackgroundJob>> {
    return adminOnlyError('client.jobs');
  }

  /**
   * Update a background job's code, schedule, or configuration.
   */
  async update(
    name: string,
    options: UpdateJobOptions,
  ): Promise<ApiResult<BackgroundJob>> {
    return adminOnlyError('client.jobs');
  }

  /**
   * Delete a background job.
   */
  async delete(name: string): Promise<ApiResult<{ success: boolean }>> {
    return adminOnlyError('client.jobs');
  }

  /**
   * Manually trigger a background job to run immediately.
   */
  async trigger(name: string): Promise<ApiResult<BackgroundJobRun>> {
    return adminOnlyError('client.jobs');
  }

  /**
   * Get execution history for a background job.
   */
  async getRuns(
    name: string,
    options?: { limit?: number },
  ): Promise<ApiResult<BackgroundJobRun[]>> {
    return adminOnlyError('client.jobs');
  }
}
