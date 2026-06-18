import type { HttpClient } from './client';
import type {
  QueryResult,
  TableMetadata,
  PaginationOptions,
  RlsPolicy,
  ApiResult,
} from '../types';

export class DatabaseClient {
  constructor(private client: HttpClient) {}

  /**
   * Get the base path for client database operations.
   *
   * Note: this path is intentionally **singular** (`/api/project/:slug/...`).
   * The plural form (`/api/projects/:projectId/...`) is reserved for the
   * admin/Studio routes which authenticate with the global JWT_SECRET. The
   * client SDK uses a per-project anon/service key, so it must hit the
   * singular endpoint where `ApiKeyGuard` validates with the project's own
   * `jwt_secret`.
   */
  private get basePath(): string {
    return `/api/project/${this.client.getProjectSlug()}/database`;
  }

  /**
   * Execute a raw SQL query with optional parameter binding.
   *
   * Params are bound on the backend via `pg`'s native $1/$2/... placeholders
   * (see studio_api `ProjectDatabaseUtil.query`). Always prefer this over
   * string interpolation when you have untrusted input:
   *
   *   db.query('SELECT * FROM users WHERE email = $1', [email])
   */
  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<ApiResult<QueryResult<T>>> {
    const result = await this.client.request<{
      success: boolean;
      data: T[];
      rows_affected: number;
      columns?: Array<{ name: string; type: string }>;
    }>(`${this.basePath}/sql`, {
      method: 'POST',
      body: params && params.length > 0 ? { sql, params } : { sql },
    });

    if (result.error) {
      return result as ApiResult<QueryResult<T>>;
    }

    // Transform API response to QueryResult format
    return {
      data: {
        rows: result.data.data || [],
        rowCount: result.data.rows_affected || 0,
        fields: result.data.columns?.map(col => ({ name: col.name, dataType: col.type })),
      },
      error: null,
    };
  }

  /**
   * Get all tables in the database
   */
  async listTables(): Promise<ApiResult<string[]>> {
    return this.client.request<string[]>(`${this.basePath}/tables/list`);
  }

  /**
   * Get table metadata including columns
   */
  async getTableMetadata(tableName: string): Promise<ApiResult<TableMetadata>> {
    const query = new URLSearchParams({ table: tableName });
    return this.client.request<TableMetadata>(`${this.basePath}/tables?${query.toString()}`);
  }

  /**
   * Get table data with pagination
   */
  async getTableData<T = Record<string, unknown>>(
    tableName: string,
    options: PaginationOptions = {}
  ): Promise<ApiResult<{ rows: T[]; total: number }>> {
    const params = new URLSearchParams();
    if (options.page) params.set('page', options.page.toString());
    if (options.limit) params.set('limit', options.limit.toString());
    if (options.sortBy) params.set('sortBy', options.sortBy);
    if (options.sortOrder) params.set('sortOrder', options.sortOrder);

    const query = params.toString() ? `?${params.toString()}` : '';
    return this.client.request<{ rows: T[]; total: number }>(
      `${this.basePath}/tables/${encodeURIComponent(tableName)}/data${query}`
    );
  }

  /**
   * Insert a row into a table
   * Returns the inserted row data
   */
  async insert<T = Record<string, unknown>>(
    tableName: string,
    data: Record<string, unknown>
  ): Promise<ApiResult<T>> {
    const result = await this.client.request<{
      success: boolean;
      data: T[];
      rows_affected: number;
      message: string;
    }>(`${this.basePath}/tables/${encodeURIComponent(tableName)}/rows`, {
      method: 'POST',
      body: data,
    });

    if (result.error) {
      return result as ApiResult<T>;
    }

    // Return the first inserted row
    return {
      data: result.data.data?.[0] || (result.data as unknown as T),
      error: null,
    };
  }

  /**
   * Update a row by ID
   * Note: Requires service_role_key for authentication
   */
  async update<T = Record<string, unknown>>(
    tableName: string,
    rowId: string | number,
    data: Record<string, unknown>
  ): Promise<ApiResult<T>> {
    const result = await this.client.request<{
      success: boolean;
      data: T;
      message: string;
    }>(`${this.basePath}/tables/${encodeURIComponent(tableName)}/rows/${encodeURIComponent(String(rowId))}`, {
      method: 'PUT',
      body: data,
    });

    if (result.error) {
      return result as ApiResult<T>;
    }

    return {
      data: result.data.data || (result.data as unknown as T),
      error: null,
    };
  }

  /**
   * Delete a row by ID
   * Note: Requires service_role_key for authentication
   */
  async delete(tableName: string, rowId: string | number): Promise<ApiResult<{ success: boolean }>> {
    return this.client.request<{ success: boolean }>(
      `${this.basePath}/tables/${encodeURIComponent(tableName)}/rows/${encodeURIComponent(String(rowId))}`,
      { method: 'DELETE' }
    );
  }

  /**
   * Bulk insert rows
   * Note: Requires service_role_key for authentication
   */
  async bulkInsert<T = Record<string, unknown>>(
    tableName: string,
    rows: Record<string, unknown>[]
  ): Promise<ApiResult<T[]>> {
    return this.client.request<T[]>(`${this.basePath}/tables/${encodeURIComponent(tableName)}/rows/bulk`, {
      method: 'POST',
      body: rows,
    });
  }

  /**
   * Bulk update rows
   * Note: Requires service_role_key for authentication
   */
  async bulkUpdate<T = Record<string, unknown>>(
    tableName: string,
    updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>
  ): Promise<ApiResult<T[]>> {
    return this.client.request<T[]>(`${this.basePath}/tables/${encodeURIComponent(tableName)}/rows/bulk`, {
      method: 'PUT',
      body: updates,
    });
  }

  /**
   * Bulk delete rows
   * Note: Requires service_role_key for authentication
   */
  async bulkDelete(
    tableName: string,
    conditions: Record<string, unknown>[]
  ): Promise<ApiResult<{ deleted: number }>> {
    return this.client.request<{ deleted: number }>(
      `${this.basePath}/tables/${encodeURIComponent(tableName)}/rows/bulk`,
      {
        method: 'DELETE',
        body: conditions,
      }
    );
  }

  /**
   * Enable Row Level Security on a table
   */
  async enableRls(tableName: string): Promise<ApiResult<{ success: boolean }>> {
    return this.client.request<{ success: boolean }>(
      `${this.basePath}/tables/${encodeURIComponent(tableName)}/rls/enable`,
      { method: 'POST' }
    );
  }

  /**
   * Disable Row Level Security on a table
   */
  async disableRls(tableName: string): Promise<ApiResult<{ success: boolean }>> {
    return this.client.request<{ success: boolean }>(
      `${this.basePath}/tables/${encodeURIComponent(tableName)}/rls/disable`,
      { method: 'POST' }
    );
  }

  /**
   * Create an RLS policy
   */
  async createPolicy(tableName: string, policy: RlsPolicy): Promise<ApiResult<{ success: boolean }>> {
    return this.client.request<{ success: boolean }>(
      `${this.basePath}/tables/${encodeURIComponent(tableName)}/policies`,
      {
        method: 'POST',
        body: policy,
      }
    );
  }

  /**
   * List RLS policies for a table
   */
  async listPolicies(tableName: string): Promise<ApiResult<RlsPolicy[]>> {
    return this.client.request<RlsPolicy[]>(`${this.basePath}/tables/${encodeURIComponent(tableName)}/policies`);
  }

  /**
   * Delete an RLS policy
   */
  async deletePolicy(tableName: string, policyName: string): Promise<ApiResult<{ success: boolean }>> {
    return this.client.request<{ success: boolean }>(
      `${this.basePath}/tables/${encodeURIComponent(tableName)}/policies/${encodeURIComponent(policyName)}`,
      { method: 'DELETE' }
    );
  }

  /**
   * Create a fluent query builder for a table
   */
  from(tableName: string): TableQueryBuilder {
    return new TableQueryBuilder(this, tableName);
  }
}

const SAFE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

type QueryFilter = { col: string; op: string; value: unknown };

/**
 * Fluent, Supabase-style query builder. Filters/ordering/pagination compose into
 * a single parameterized SELECT executed via the SQL endpoint — so values are
 * always bound ($1, $2, …), never interpolated, and RLS still applies. Mirrors
 * the Flutter SDK's builder so the two SDKs feel the same.
 *
 * ```ts
 * const { data } = await client.db.from('posts')
 *   .eq('status', 'published')
 *   .gt('views', 100)
 *   .order('created_at', { ascending: false })
 *   .limit(10)
 *   .select('id, title, views');
 * ```
 */
class TableQueryBuilder {
  private _filters: QueryFilter[] = [];
  private _orders: Array<{ col: string; asc: boolean }> = [];
  private _limit?: number;
  private _offset?: number;
  private _columns = '*';

  constructor(
    private db: DatabaseClient,
    private tableName: string,
  ) {
    this.ident(tableName);
  }

  private ident(name: string): string {
    if (!SAFE_IDENT.test(name)) {
      throw new Error(`OrbitNest: unsafe SQL identifier "${name}"`);
    }
    return `"${name}"`;
  }

  // ── Filter operators (match the backend's supported set) ──────────────────
  eq(column: string, value: unknown): this { return this.push(column, 'eq', value); }
  neq(column: string, value: unknown): this { return this.push(column, 'neq', value); }
  gt(column: string, value: unknown): this { return this.push(column, 'gt', value); }
  gte(column: string, value: unknown): this { return this.push(column, 'gte', value); }
  lt(column: string, value: unknown): this { return this.push(column, 'lt', value); }
  lte(column: string, value: unknown): this { return this.push(column, 'lte', value); }
  like(column: string, pattern: string): this { return this.push(column, 'like', pattern); }
  ilike(column: string, pattern: string): this { return this.push(column, 'ilike', pattern); }
  in(column: string, values: unknown[]): this { return this.push(column, 'in', values); }
  is(column: string, value: null | boolean): this { return this.push(column, 'is', value); }

  private push(column: string, op: string, value: unknown): this {
    this.ident(column);
    this._filters.push({ col: column, op, value });
    return this;
  }

  // ── Ordering / pagination ─────────────────────────────────────────────────
  order(column: string, opts?: { ascending?: boolean }): this {
    this.ident(column);
    this._orders.push({ col: column, asc: opts?.ascending !== false });
    return this;
  }
  /** @deprecated use {@link order} */
  orderBy(column: string, dir: 'ASC' | 'DESC' = 'ASC'): this {
    return this.order(column, { ascending: dir === 'ASC' });
  }
  limit(n: number): this { this._limit = n; return this; }
  /** Inclusive range, like Supabase: `.range(0, 9)` → first 10 rows. */
  range(from: number, to: number): this {
    this._offset = from;
    this._limit = to - from + 1;
    return this;
  }
  page(n: number, size = 20): this {
    this._limit = size;
    this._offset = Math.max(0, (n - 1) * size);
    return this;
  }

  private build(): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    const cols =
      this._columns === '*'
        ? '*'
        : this._columns.split(',').map((c) => this.ident(c.trim())).join(', ');
    let sql = `SELECT ${cols} FROM ${this.ident(this.tableName)}`;

    const where: string[] = [];
    for (const f of this._filters) {
      const col = this.ident(f.col);
      switch (f.op) {
        case 'eq': where.push(`${col} = $${params.push(f.value)}`); break;
        case 'neq': where.push(`${col} != $${params.push(f.value)}`); break;
        case 'gt': where.push(`${col} > $${params.push(f.value)}`); break;
        case 'gte': where.push(`${col} >= $${params.push(f.value)}`); break;
        case 'lt': where.push(`${col} < $${params.push(f.value)}`); break;
        case 'lte': where.push(`${col} <= $${params.push(f.value)}`); break;
        case 'like': where.push(`${col} LIKE $${params.push(f.value)}`); break;
        case 'ilike': where.push(`${col} ILIKE $${params.push(f.value)}`); break;
        case 'in': {
          const vals = (f.value as unknown[]) ?? [];
          if (vals.length === 0) { where.push('FALSE'); break; }
          where.push(`${col} IN (${vals.map((v) => `$${params.push(v)}`).join(', ')})`);
          break;
        }
        case 'is':
          if (f.value === null) where.push(`${col} IS NULL`);
          else where.push(`${col} = $${params.push(f.value)}`);
          break;
      }
    }
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    if (this._orders.length)
      sql += ` ORDER BY ${this._orders.map((o) => `${this.ident(o.col)} ${o.asc ? 'ASC' : 'DESC'}`).join(', ')}`;
    if (this._limit != null) sql += ` LIMIT $${params.push(this._limit)}`;
    if (this._offset != null) sql += ` OFFSET $${params.push(this._offset)}`;
    return { sql, params };
  }

  /** Run the built SELECT. Returns `{ rows, total }` (total = rows returned). */
  async select<T = Record<string, unknown>>(columns = '*'): Promise<ApiResult<{ rows: T[]; total: number }>> {
    this._columns = columns;
    const { sql, params } = this.build();
    const res = await this.db.query<T>(sql, params);
    if (res.error) return res as ApiResult<{ rows: T[]; total: number }>;
    return { data: { rows: res.data.rows, total: res.data.rows.length }, error: null };
  }

  /** Expect exactly one row; errors if zero rows. */
  async single<T = Record<string, unknown>>(columns = '*'): Promise<ApiResult<T>> {
    this._limit = 1;
    const res = await this.select<T>(columns);
    if (res.error) return res as ApiResult<T>;
    const row = res.data.rows[0];
    if (!row) return { data: null, error: { message: 'No rows found', code: 'NOT_FOUND' } };
    return { data: row, error: null };
  }

  /** Return the first row or null (no error when empty). */
  async maybeSingle<T = Record<string, unknown>>(columns = '*'): Promise<ApiResult<T | null>> {
    this._limit = 1;
    const res = await this.select<T>(columns);
    if (res.error) return res as ApiResult<T | null>;
    return { data: res.data.rows[0] ?? null, error: null };
  }

  // ── Writes (delegate to the row endpoints) ────────────────────────────────
  async insert<T = Record<string, unknown>>(data: Record<string, unknown>): Promise<ApiResult<T>> {
    return this.db.insert<T>(this.tableName, data);
  }
  async update<T = Record<string, unknown>>(id: string | number, data: Record<string, unknown>): Promise<ApiResult<T>> {
    return this.db.update<T>(this.tableName, id, data);
  }
  async delete(id: string | number): Promise<ApiResult<{ success: boolean }>> {
    return this.db.delete(this.tableName, id);
  }
}
