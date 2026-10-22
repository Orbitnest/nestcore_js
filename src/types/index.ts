// Configuration
//
// Only `apiKey` is required. The project slug is decoded from the JWT
// payload of the API key (it carries `project_slug` as a claim), and
// `baseUrl` defaults to https://api.orbitnest.io. Pass them explicitly
// only when you need to override (e.g. local dev pointing at a custom
// API host).
export interface OrbitNestConfig {
  apiKey: string;
  projectSlug?: string;
  baseUrl?: string;
  timeout?: number;
  /** Ingest-only token for analytics. When supplied, analytics requests
   *  send it as `x-analytics-token` alongside the standard Bearer auth.
   *  Scoped exclusively to event ingestion — cannot read or mutate data. */
  analyticsToken?: string;
  /** Directory containing ordered `*.sql` migration files. Default `migrations`
   *  (resolved from the process working directory). Used by `client.migrations`. */
  migrationsDir?: string;
  /**
   * Server-side only: the end user's IP when your server calls auth for them
   * (e.g. a Next.js server action). Sent as `X-OrbitNest-Client-IP` and honoured
   * only with the service_role key, so each user gets their own throttle
   * bucket instead of sharing your server's. Create one client per request.
   */
  clientIp?: string;
}

// HTTP
export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: unknown;
  headers?: Record<string, string>;
  timeout?: number;
  /** Let the request outlive the page (used to flush analytics on unload). */
  keepalive?: boolean;
}

export interface ApiResponse<T = unknown> {
  data: T;
  error: null;
}

export interface ApiError {
  data: null;
  error: {
    message: string;
    code?: string;
    status?: number;
    /** Parsed error body, when the SDK has one (e.g. a function's 4xx JSON). */
    details?: unknown;
  };
}

export type ApiResult<T> = ApiResponse<T> | ApiError;

// Database
export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
  fields?: Array<{ name: string; dataType: string }>;
}

/** One table as returned by `GET /database/tables` (columns from information_schema). */
export interface TableMetadata {
  table_name: string;
  rls_enabled?: boolean;
  columns: Array<{
    column_name: string;
    /** information_schema `data_type`, e.g. `integer`, `character varying`, `ARRAY`. */
    data_type: string;
    is_nullable: boolean;
    column_default: string | null;
    ordinal_position?: number;
    constraint_type?: string | null;
  }>;
}

export interface PaginationOptions {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
}

export interface RlsPolicy {
  name: string;
  command: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALL';
  definition: string;
  check?: string;
  roles?: string[];
}

// Edge Functions
export interface FunctionInvokeOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
}

export interface FunctionResponse<T = unknown> {
  data: T;
  status: number;
  headers: Record<string, string>;
}

// Background Jobs
export interface BackgroundJob {
  id: string;
  name: string;
  description?: string;
  sourceCode: string;
  status: 'active' | 'inactive';
  schedule: string;
  timezone: string;
  executionConfig?: {
    timeout?: number;
    memory?: number;
    enableLogs?: boolean;
  };
  maxConcurrentRuns: number;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BackgroundJobRun {
  id: string;
  jobId: string;
  executionId: string;
  triggerType: 'scheduled' | 'manual';
  status: 'running' | 'success' | 'error' | 'timeout' | 'skipped';
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  errorMessage?: string;
  result?: unknown;
  createdAt: string;
}

export interface CreateJobOptions {
  name: string;
  description?: string;
  sourceCode: string;
  schedule: string;
  timezone?: string;
  executionConfig?: {
    timeout?: number;
    memory?: number;
    enableLogs?: boolean;
  };
}

export interface UpdateJobOptions {
  description?: string;
  sourceCode?: string;
  status?: 'active' | 'inactive';
  schedule?: string;
  timezone?: string;
  executionConfig?: {
    timeout?: number;
    memory?: number;
    enableLogs?: boolean;
  };
}

// Auth
export interface AuthUser {
  id: string;
  email: string;
  email_confirmed_at?: string;
  created_at: string;
  updated_at: string;
  user_metadata?: Record<string, unknown>;
  /** Set while an email change waits for `verifyEmailChange`. */
  new_email?: string | null;
}

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  /** Unix seconds when `access_token` expires. Set by the SDK from `expires_in`. */
  expires_at?: number;
  token_type: string;
  user: AuthUser;
}

export interface SignUpCredentials {
  email: string;
  password: string;
  metadata?: Record<string, unknown>;
}

export interface SignInCredentials {
  email: string;
  password: string;
}

export interface PasswordRecoveryOptions {
  email: string;
}

export interface PasswordResetOptions {
  /** Email the recovery OTP was sent to. Required — the API needs it to
   *  locate the account since the OTP itself is not a JWT. */
  email: string;
  /** Code from the recovery email (otp_config.code_length digits, 6 by default). Named `token` for API symmetry
   *  with other auth providers; the wire value is the OTP code. */
  token: string;
  /** New password to set on the account. */
  password: string;
}

// ─── Passkey / WebAuthn ─────────────────────────────────────────────────────

/**
 * A registered WebAuthn credential bound to the current user.
 */
export interface PasskeyDevice {
  id: string;
  device_name: string | null;
  transports: string[];
  backup_eligible: boolean;
  created_at: string;
  last_used_at: string | null;
}

/**
 * Server-issued attestation options for a passkey registration ceremony.
 * Pass `publicKey` to `@simplewebauthn/browser`'s `startRegistration({ optionsJSON })`.
 */
export interface PasskeyRegistrationOptions {
  publicKey: Record<string, unknown>;
  challenge_id: string;
  device_name: string | null;
}

/**
 * Server-issued assertion options for a passkey sign-in ceremony.
 * Pass `publicKey` to `@simplewebauthn/browser`'s `startAuthentication({ optionsJSON })`.
 */
export interface PasskeyAuthenticationOptions {
  publicKey: Record<string, unknown>;
  challenge_id: string;
}

export interface PasskeyRegisterVerifyOptions {
  challenge_id: string;
  attestation: Record<string, unknown>;
  device_name?: string;
}

export interface PasskeyAuthenticateVerifyOptions {
  challenge_id: string;
  assertion: Record<string, unknown>;
}

export interface PasskeySignUpOptions {
  email: string;
  /**
   * Arbitrary user metadata. To populate the display name shown in the
   * native "save passkey" sheet on iOS / Credential Manager on Android,
   * set `user_metadata.full_name`. Missing/empty values fall back to the
   * email address — which makes the native UI look confusing to users.
   */
  user_metadata?: Record<string, unknown>;
  device_name?: string;
}

export interface PasskeySignUpVerifyOptions {
  challenge_id: string;
  attestation: Record<string, unknown>;
  device_name?: string;
}

export interface UpdateUserOptions {
  email?: string;
  password?: string;
  /** Required (for accounts with a password) when changing `email` or `password`. */
  current_password?: string;
  /** Merged into the user's `user_metadata`. */
  metadata?: Record<string, unknown>;
}
