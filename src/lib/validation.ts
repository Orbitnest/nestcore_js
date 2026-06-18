import type { ApiResult } from '../types';

/**
 * Validate a required string parameter. Returns an error result if invalid.
 */
export function validateRequired(value: unknown, paramName: string): ApiResult<never> | null {
  if (!value || typeof value !== 'string' || value.trim().length === 0) {
    return {
      data: null,
      error: { message: `${paramName} is required and must be a non-empty string`, code: 'VALIDATION_ERROR' },
    };
  }
  return null;
}

/**
 * Validate a file/storage path. Returns an error result if invalid.
 * Rejects path traversal attempts (../) and null bytes.
 */
export function validatePath(path: string, paramName: string = 'path'): ApiResult<never> | null {
  const required = validateRequired(path, paramName);
  if (required) return required;

  // Block null bytes
  if (path.includes('\0')) {
    return {
      data: null,
      error: { message: `${paramName} must not contain null bytes`, code: 'VALIDATION_ERROR' },
    };
  }

  // Block path traversal
  const segments = path.split('/');
  for (const seg of segments) {
    if (seg === '..') {
      return {
        data: null,
        error: { message: `${paramName} must not contain path traversal sequences`, code: 'VALIDATION_ERROR' },
      };
    }
  }

  return null;
}

/**
 * Sanitize a storage path for FormData submission.
 * Normalizes separators and strips leading slashes / traversal.
 */
export function sanitizePath(path: string): string {
  return path
    .replace(/\\/g, '/')          // normalize backslashes
    .split('/')
    .filter(seg => seg !== '..' && seg !== '' && seg !== '.')
    .join('/');
}
