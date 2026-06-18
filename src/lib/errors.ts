import type { ApiResult } from '../types';

/**
 * Error thrown by {@link unwrap}. Carries the API error's `code` and HTTP
 * `status` so callers can branch on them — the throwing counterpart to the
 * `{ data, error }` result model (and a match for the Flutter SDK's
 * `OrbitNestException`).
 */
export class OrbitNestError extends Error {
  readonly code?: string;
  readonly status?: number;
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message);
    this.name = 'OrbitNestError';
    this.code = opts.code;
    this.status = opts.status;
  }
}

/**
 * Bridge the `{ data, error }` result model to a throwing style: returns
 * `data` on success, throws {@link OrbitNestError} on error. Lets you opt into
 * `try/catch` ergonomics (as the Flutter SDK uses) without changing the default
 * non-throwing behavior of the SDK.
 *
 * ```ts
 * import { unwrap } from '@orbitnest/js';
 *
 * try {
 *   const { rows } = unwrap(await orbit.db.from('posts').select());
 * } catch (e) {
 *   if (e instanceof OrbitNestError) console.error(e.code, e.status, e.message);
 * }
 * ```
 */
export function unwrap<T>(result: ApiResult<T>): T {
  if (result.error) {
    throw new OrbitNestError(result.error.message, {
      code: result.error.code,
      status: result.error.status,
    });
  }
  return result.data as T;
}
