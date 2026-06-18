import type { HttpClient } from './client';
import type { ApiResult } from '../types';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  metadata?: Record<string, unknown>;
  source?: string;
}

export interface LogQueryOptions {
  level?: 'debug' | 'info' | 'warn' | 'error';
  since?: Date;
  until?: Date;
  limit?: number;
  offset?: number;
  source?: string;
}

export class LoggingClient {
  constructor(private client: HttpClient) {}

  private get basePath(): string {
    return `/api/projects/${this.client.getProjectSlug()}/logs`;
  }

  /**
   * Get all logs
   */
  async getLogs(options: LogQueryOptions = {}): Promise<ApiResult<LogEntry[]>> {
    const params = new URLSearchParams();
    if (options.level) params.set('level', options.level);
    if (options.since) params.set('since', options.since.toISOString());
    if (options.until) params.set('until', options.until.toISOString());
    if (options.limit) params.set('limit', options.limit.toString());
    if (options.offset) params.set('offset', options.offset.toString());
    if (options.source) params.set('source', options.source);

    const query = params.toString() ? `?${params.toString()}` : '';
    return this.client.request<LogEntry[]>(`${this.basePath}${query}`);
  }

  /**
   * Get database logs
   */
  async getDatabaseLogs(options: LogQueryOptions = {}): Promise<ApiResult<LogEntry[]>> {
    const params = new URLSearchParams();
    if (options.limit) params.set('limit', options.limit.toString());
    if (options.since) params.set('since', options.since.toISOString());

    const query = params.toString() ? `?${params.toString()}` : '';
    return this.client.request<LogEntry[]>(`${this.basePath}/database${query}`);
  }

  /**
   * Get slow query logs
   */
  async getSlowQueryLogs(options: LogQueryOptions = {}): Promise<ApiResult<LogEntry[]>> {
    const params = new URLSearchParams();
    if (options.limit) params.set('limit', options.limit.toString());

    const query = params.toString() ? `?${params.toString()}` : '';
    return this.client.request<LogEntry[]>(`${this.basePath}/database/slow${query}`);
  }

  /**
   * Get auth logs
   */
  async getAuthLogs(options: LogQueryOptions = {}): Promise<ApiResult<LogEntry[]>> {
    const params = new URLSearchParams();
    if (options.limit) params.set('limit', options.limit.toString());
    if (options.since) params.set('since', options.since.toISOString());

    const query = params.toString() ? `?${params.toString()}` : '';
    return this.client.request<LogEntry[]>(`${this.basePath}/auth${query}`);
  }

  /**
   * Get auth failure logs
   */
  async getAuthFailures(options: LogQueryOptions = {}): Promise<ApiResult<LogEntry[]>> {
    const params = new URLSearchParams();
    if (options.limit) params.set('limit', options.limit.toString());

    const query = params.toString() ? `?${params.toString()}` : '';
    return this.client.request<LogEntry[]>(`${this.basePath}/auth/failures${query}`);
  }

  /**
   * Get edge function logs
   */
  async getEdgeFunctionLogs(
    functionName?: string,
    options: LogQueryOptions = {}
  ): Promise<ApiResult<LogEntry[]>> {
    const params = new URLSearchParams();
    if (options.limit) params.set('limit', options.limit.toString());
    if (options.since) params.set('since', options.since.toISOString());

    const query = params.toString() ? `?${params.toString()}` : '';
    const path = functionName
      ? `${this.basePath}/edge-functions/${encodeURIComponent(functionName)}`
      : `${this.basePath}/edge-functions`;

    return this.client.request<LogEntry[]>(`${path}${query}`);
  }
}
