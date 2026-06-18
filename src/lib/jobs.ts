import type { HttpClient } from './client';
import type {
  BackgroundJob,
  BackgroundJobRun,
  CreateJobOptions,
  UpdateJobOptions,
  ApiResult,
} from '../types';

export class JobsClient {
  constructor(private client: HttpClient) {}

  private get basePath(): string {
    return `/api/projects/${this.client.getProjectSlug()}/jobs`;
  }

  /**
   * Create a background job with a cron schedule.
   */
  async create(options: CreateJobOptions): Promise<ApiResult<BackgroundJob>> {
    return this.client.request<BackgroundJob>(this.basePath, {
      method: 'POST',
      body: options,
    });
  }

  /**
   * List all background jobs for the current project.
   */
  async list(): Promise<ApiResult<BackgroundJob[]>> {
    const result = await this.client.request<{ jobs: BackgroundJob[]; total: number }>(
      this.basePath,
    );
    if (result.error) return result as ApiResult<BackgroundJob[]>;
    return { data: result.data?.jobs ?? [], error: null };
  }

  /**
   * Get a single background job by name.
   */
  async get(name: string): Promise<ApiResult<BackgroundJob>> {
    return this.client.request<BackgroundJob>(`${this.basePath}/${encodeURIComponent(name)}`);
  }

  /**
   * Update a background job's code, schedule, or configuration.
   */
  async update(
    name: string,
    options: UpdateJobOptions,
  ): Promise<ApiResult<BackgroundJob>> {
    return this.client.request<BackgroundJob>(
      `${this.basePath}/${encodeURIComponent(name)}`,
      { method: 'PUT', body: options },
    );
  }

  /**
   * Delete a background job.
   */
  async delete(name: string): Promise<ApiResult<{ success: boolean }>> {
    return this.client.request<{ success: boolean }>(
      `${this.basePath}/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    );
  }

  /**
   * Manually trigger a background job to run immediately.
   */
  async trigger(name: string): Promise<ApiResult<BackgroundJobRun>> {
    return this.client.request<BackgroundJobRun>(
      `${this.basePath}/${encodeURIComponent(name)}/trigger`,
      { method: 'POST' },
    );
  }

  /**
   * Get execution history for a background job.
   */
  async getRuns(
    name: string,
    options?: { limit?: number },
  ): Promise<ApiResult<BackgroundJobRun[]>> {
    const query = options?.limit ? `?limit=${options.limit}` : '';
    const result = await this.client.request<{ runs: BackgroundJobRun[]; total: number }>(
      `${this.basePath}/${encodeURIComponent(name)}/runs${query}`,
    );
    if (result.error) return result as ApiResult<BackgroundJobRun[]>;
    return { data: result.data?.runs ?? [], error: null };
  }
}
