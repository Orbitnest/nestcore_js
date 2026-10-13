import { adminOnlyError, type HttpClient } from './client';
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

/**
 * @deprecated Not usable with a project API key: these routes need a Studio
 * admin token. Every method resolves to an `ADMIN_ONLY` error without calling
 * the API. Use OrbitNest Studio, the CLI or the MCP server instead.
 */
export class LoggingClient {
  constructor(private client: HttpClient) {}

  /**
   * Get all logs
   */
  async getLogs(options: LogQueryOptions = {}): Promise<ApiResult<LogEntry[]>> {
    return adminOnlyError('client.logs');
  }

  /**
   * Get database logs
   */
  async getDatabaseLogs(options: LogQueryOptions = {}): Promise<ApiResult<LogEntry[]>> {
    return adminOnlyError('client.logs');
  }

  /**
   * Get slow query logs
   */
  async getSlowQueryLogs(options: LogQueryOptions = {}): Promise<ApiResult<LogEntry[]>> {
    return adminOnlyError('client.logs');
  }

  /**
   * Get auth logs
   */
  async getAuthLogs(options: LogQueryOptions = {}): Promise<ApiResult<LogEntry[]>> {
    return adminOnlyError('client.logs');
  }

  /**
   * Get auth failure logs
   */
  async getAuthFailures(options: LogQueryOptions = {}): Promise<ApiResult<LogEntry[]>> {
    return adminOnlyError('client.logs');
  }

  /**
   * Get edge function logs
   */
  async getEdgeFunctionLogs(
    functionName?: string,
    options: LogQueryOptions = {}
  ): Promise<ApiResult<LogEntry[]>> {
    return adminOnlyError('client.logs');
  }
}
