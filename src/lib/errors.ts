import type { ApiResult } from '../types';

/**
 * Error thrown by {@link unwrap}. Carries the API error's `code` and HTTP
 * `status` so callers can branch on them — the throwing counterpart to the
 * `{ data, error }` result model (and a match for the Flutter SDK's
 * `NestCoreException`).
 */
export class NestCoreError extends Error {
  readonly code?: string;
  readonly status?: number;
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message);
    this.name = 'NestCoreError';
    this.code = opts.code;
    this.status = opts.status;
  }
}

/** @deprecated Renamed to {@link NestCoreError}; kept so existing `instanceof` checks keep working. */
export const OrbitNestError = NestCoreError;
/** @deprecated Renamed to {@link NestCoreError}. */
export type OrbitNestError = NestCoreError;

/**
 * Bridge the `{ data, error }` result model to a throwing style: returns
 * `data` on success, throws {@link NestCoreError} on error. Lets you opt into
 * `try/catch` ergonomics (as the Flutter SDK uses) without changing the default
 * non-throwing behavior of the SDK.
 *
 * ```ts
 * import { unwrap } from '@nestcore/js';
 *
 * try {
 *   const { rows } = unwrap(await nestcore.db.from('posts').select());
 * } catch (e) {
 *   if (e instanceof NestCoreError) console.error(e.code, e.status, e.message);
 * }
 * ```
 */
export function unwrap<T>(result: ApiResult<T>): T {
  if (result.error) {
    throw new NestCoreError(result.error.message, {
      code: result.error.code,
      status: result.error.status,
    });
  }
  return result.data as T;
}

/**
 * `error.code` values for the project auth limits (all HTTP 429). The limits
 * are set per project in Console → Settings → Auth Security.
 */
export const AuthLimitCodes = {
  /** Too many wrong codes: codes are invalidated for a while. */
  OTP_RATE_LIMITED: 'OTP_RATE_LIMITED',
  /** Too many codes requested for one email in the last hour. */
  OTP_REQUEST_LIMIT: 'OTP_REQUEST_LIMIT',
  /** Too many wrong passwords: the email is locked for the lockout duration. */
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
} as const;
