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
  /**
   * Rows nearest to `query` by meaning, from a column embedded with automatic
   * embeddings (Studio → AI → Embeddings). Runs under RLS as the signed-in user.
   * Each row carries `_similarity` (cosine) and `_score`. With `hybridColumn`,
   * keyword matches on that text column are blended in (reciprocal rank fusion).
   * Usually reached through `db.from(table).eq(...).semantic(column, query)`.
   */
  async semantic<T = Record<string, unknown>>(
    table: string,
    column: string,
    query: string,
    opts: SemanticOptions & { filters?: SemanticFilter[] } = {},
  ): Promise<ApiResult<{ rows: Array<T & { _similarity: number | null; _score: number }>; model: string | null }>> {
    return this.client.request(`${this.basePath}/semantic`, { method: 'POST', body: { table, column, query, ...opts } });
  }

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
   * Get table metadata including columns. The API returns one entry per
   * matching table (an empty array when the table doesn't exist).
   */
  async getTableMetadata(tableName: string): Promise<ApiResult<TableMetadata[]>> {
    const query = new URLSearchParams({ table: tableName });
    return this.client.request<TableMetadata[]>(`${this.basePath}/tables?${query.toString()}`);
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
    const result = await this.client.request<{ data: T[]; total_rows: number }>(
      `${this.basePath}/tables/${encodeURIComponent(tableName)}/data${query}`
    );
    if (result.error) return result;
    return { data: { rows: result.data.data ?? [], total: result.data.total_rows ?? 0 }, error: null };
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
      data: T[];
      message: string;
    }>(`${this.basePath}/tables/${encodeURIComponent(tableName)}/rows/${encodeURIComponent(String(rowId))}`, {
      method: 'PUT',
      body: data,
    });

    if (result.error) {
      return result as ApiResult<T>;
    }

    // The API returns the updated rows as an array; return the row.
    return {
      data: result.data.data?.[0] ?? (result.data as unknown as T),
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
   * Bulk insert rows. Returns the inserted rows.
   * Note: Requires service_role_key for authentication
   */
  async bulkInsert<T = Record<string, unknown>>(
    tableName: string,
    rows: Record<string, unknown>[]
  ): Promise<ApiResult<T[]>> {
    const result = await this.client.request<{ data?: T[] }>(`${this.basePath}/tables/${encodeURIComponent(tableName)}/rows/bulk`, {
      method: 'POST',
      body: rows,
    });
    if (result.error) return result;
    return { data: result.data.data ?? [], error: null };
  }

  /**
   * Bulk update rows. Returns the number of rows updated.
   * Note: Requires a service_role key or a signed-in user (RLS applies)
   */
  async bulkUpdate(
    tableName: string,
    updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>
  ): Promise<ApiResult<{ updated: number }>> {
    const result = await this.client.request<{ rows_affected?: number }>(`${this.basePath}/tables/${encodeURIComponent(tableName)}/rows/bulk`, {
      method: 'PUT',
      body: updates,
    });
    if (result.error) return result;
    return { data: { updated: result.data.rows_affected ?? 0 }, error: null };
  }

  /**
   * Bulk delete rows. Returns the number of rows deleted.
   * Note: Requires a service_role key or a signed-in user (RLS applies)
   */
  async bulkDelete(
    tableName: string,
    conditions: Record<string, unknown>[]
  ): Promise<ApiResult<{ deleted: number }>> {
    const result = await this.client.request<{ rows_affected?: number }>(
      `${this.basePath}/tables/${encodeURIComponent(tableName)}/rows/bulk`,
      {
        method: 'DELETE',
        body: conditions,
      }
    );
    if (result.error) return result;
    return { data: { deleted: result.data.rows_affected ?? 0 }, error: null };
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
    const result = await this.client.request<{
      policies?: Array<{ name: string; command: RlsPolicy['command']; role?: string; using?: string | null; with_check?: string | null }>;
    }>(`${this.basePath}/tables/${encodeURIComponent(tableName)}/policies`);
    if (result.error) return result;
    // Map the API's pg_policies shape to the RlsPolicy fields createPolicy takes.
    const policies = (result.data.policies ?? []).map((p) => ({
      name: p.name,
      command: p.command,
      definition: p.using ?? '',
      ...(p.with_check ? { check: p.with_check } : {}),
      roles: String(p.role ?? '').replace(/[{}]/g, '').split(',').map((r) => r.trim()).filter(Boolean),
    }));
    return { data: policies, error: null };
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

type QueryFilter = { col: string; op: string; value: unknown; ftsType?: string; config?: string };

export interface SemanticOptions {
  /** Rows to return (default 10, max 100; a builder `.limit()` sets it too). */
  k?: number;
  /** A text column to also rank by keyword match. */
  hybridColumn?: string;
  /** Drop rows below this cosine similarity (0–1). */
  minSimilarity?: number;
}

export type SemanticFilter = { column: string; op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'in' | 'is'; value?: unknown };

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
  private _vectorOrder?: { col: string; vec: string; op: string };

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

  /**
   * Full-text search on a column using PostgreSQL text search.
   *
   * ```ts
   * await client.db.from('articles').textSearch('body', 'postgres & search').select();
   * ```
   *
   * @param type   `websearch` (default, Google-style operators), `plain`, or `phrase`.
   * @param config text-search configuration / language (default `english`).
   */
  textSearch(
    column: string,
    query: string,
    opts?: { type?: 'websearch' | 'plain' | 'phrase'; config?: string },
  ): this {
    this.ident(column);
    const config = opts?.config ?? 'english';
    if (!SAFE_IDENT.test(config)) {
      throw new Error(`OrbitNest: unsafe text-search config "${config}"`);
    }
    this._filters.push({ col: column, op: 'fts', value: query, ftsType: opts?.type ?? 'websearch', config });
    return this;
  }

  /**
   * Order by vector similarity (pgvector). Returns the nearest rows to
   * `vector` by the chosen distance metric, closest first.
   *
   * ```ts
   * await client.db.from('documents').nearest('embedding', queryEmbedding, { metric: 'cosine', limit: 5 }).select();
   * ```
   *
   * Requires the `vector` extension (`CREATE EXTENSION IF NOT EXISTS vector`).
   * @param metric `l2` (default, `<->`), `cosine` (`<=>`), or `ip` (`<#>`).
   */
  nearest(column: string, vector: number[], opts?: { metric?: 'l2' | 'cosine' | 'ip'; limit?: number }): this {
    this.ident(column);
    if (!Array.isArray(vector) || !vector.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      throw new Error('OrbitNest: nearest() vector must be an array of finite numbers');
    }
    const op = opts?.metric === 'cosine' ? '<=>' : opts?.metric === 'ip' ? '<#>' : '<->';
    this._vectorOrder = { col: column, vec: `[${vector.join(',')}]`, op };
    if (opts?.limit != null) this._limit = opts.limit;
    return this;
  }

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
        case 'fts': {
          // config is validated as a safe identifier in textSearch(); the query
          // value is always bound as a parameter.
          const cfg = f.config ?? 'english';
          const fn =
            f.ftsType === 'plain' ? 'plainto_tsquery'
            : f.ftsType === 'phrase' ? 'phraseto_tsquery'
            : 'websearch_to_tsquery';
          where.push(`to_tsvector('${cfg}', ${col}::text) @@ ${fn}('${cfg}', $${params.push(f.value)})`);
          break;
        }
      }
    }
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    const orderClauses: string[] = [];
    if (this._vectorOrder) {
      // vector bound as a param, cast to ::vector — values are never interpolated.
      orderClauses.push(`${this.ident(this._vectorOrder.col)} ${this._vectorOrder.op} $${params.push(this._vectorOrder.vec)}::vector`);
    }
    for (const o of this._orders) orderClauses.push(`${this.ident(o.col)} ${o.asc ? 'ASC' : 'DESC'}`);
    if (orderClauses.length) sql += ` ORDER BY ${orderClauses.join(', ')}`;
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

  /**
   * Semantic search over an embedded column, keeping this builder's filters
   * (`eq`, `gt`, `in`, …; not `textSearch` or `nearest`).
   *
   * ```ts
   * const { data } = await client.db.from('articles').eq('published', true)
   *   .semantic('body_embedding', 'how do I reset my password?', { k: 5 });
   * ```
   */
  async semantic<T = Record<string, unknown>>(column: string, query: string, opts: SemanticOptions = {}): Promise<ApiResult<{ rows: Array<T & { _similarity: number | null; _score: number }>; model: string | null }>> {
    this.ident(column);
    if (this._vectorOrder || this._filters.some((f) => f.op === 'fts')) {
      return { data: null, error: { message: 'semantic() cannot be combined with textSearch() or nearest(); use hybridColumn for keyword ranking', code: 'INVALID_QUERY' } };
    }
    const filters = this._filters.map((f) => ({ column: f.col, op: f.op as SemanticFilter['op'], value: f.value }));
    return this.db.semantic<T>(this.tableName, column, query, { k: this._limit, ...opts, ...(filters.length ? { filters } : {}) });
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
