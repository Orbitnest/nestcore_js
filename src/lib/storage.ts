import { errorMessage, type HttpClient } from './client';
import type { ApiResult } from '../types';
import { validatePath } from './validation';

/**
 * Encode a storage path for safe interpolation into a URL while preserving the
 * `/` separators that denote nested paths (e.g. `avatars/user1.png`). Each
 * segment is `encodeURIComponent`-encoded so `?`, `#`, spaces, etc. inside a
 * segment can't alter URL structure. Empty segments (from `//` or leading `/`)
 * are dropped. Use only after `validatePath()` has rejected traversal/null bytes.
 */
function encodeStoragePath(path: string): string {
  return path
    .split('/')
    .filter((seg) => seg.length > 0)
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

export interface StorageFile {
  id: string;
  bucket: string;
  path: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  url: string;
  createdAt: string;
}

/** On-the-fly image transform options for {@link StorageBucket.getPublicUrl}. */
export interface ImageTransformOptions {
  width?: number;
  height?: number;
  format?: 'webp' | 'jpeg' | 'png' | 'avif';
  quality?: number;
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
}

/** Serialize transform options into a query string (omitting empty values). */
function buildTransformQuery(t?: ImageTransformOptions): string {
  if (!t) return '';
  const p = new URLSearchParams();
  if (t.width) p.set('width', String(t.width));
  if (t.height) p.set('height', String(t.height));
  if (t.format) p.set('format', t.format);
  if (t.quality) p.set('quality', String(t.quality));
  if (t.fit) p.set('fit', t.fit);
  return p.toString();
}

export interface StorageListItem {
  name: string;
  size: number;
  createdAt: string;
}

export interface UploadOptions {
  /** @deprecated Not supported by the API; ignored. */
  cacheControl?: string;
  upsert?: boolean;
  /**
   * MIME type stored with the file. Defaults to the Blob's own type, else a
   * guess from the path's extension, else `application/octet-stream`.
   */
  contentType?: string;
}

/** Common extensions → MIME type, so Buffer/ArrayBuffer uploads aren't stored as octet-stream. */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon', pdf: 'application/pdf',
  json: 'application/json', txt: 'text/plain', csv: 'text/csv', html: 'text/html', css: 'text/css',
  js: 'text/javascript', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
  zip: 'application/zip',
};

function guessContentType(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext];
}

/** The controller wraps results as `{ data, error: null }`; return the inner payload. */
function unwrapEnvelope<T>(result: ApiResult<unknown>): ApiResult<T> {
  if (result.error) return result;
  const body = result.data as { data?: T } | null;
  return { data: (body?.data ?? body) as T, error: null };
}

export class StorageClient {
  constructor(private client: HttpClient) {}

  /**
   * Get a bucket client for performing operations
   */
  from(bucket: string): StorageBucket {
    return new StorageBucket(this.client, bucket);
  }
}

export class StorageBucket {
  constructor(
    private client: HttpClient,
    private bucket: string
  ) {}

  // The project-apiKey-authenticated client storage controller lives at the
  // singular `/api/project/:slug/storage/...` mount (StorageAuthGuard). The
  // plural `/api/projects/...` route is the studio admin controller and
  // requires a studio JWT, not a project apiKey — so the SDK uses singular.
  private get basePath(): string {
    return `/api/project/${this.client.getProjectSlug()}/storage/${this.bucket}`;
  }

  /** Absolute URL for a path relative to the configured baseUrl. */
  private absoluteUrl(path: string): string {
    return `${this.client.getBaseUrl()}${path}`;
  }

  /**
   * Upload a file to the bucket.
   *
   * Posts multipart/form-data to `POST /api/project/{slug}/storage/{bucket}/upload`
   * as the signed-in user when there is a session (the project key otherwise).
   * Sends fields:
   *   - `file`   binary
   *   - `path`   destination path inside the bucket
   *   - `upsert` "true" if overwriting (optional)
   */
  async upload(
    path: string,
    file: Blob | File | ArrayBuffer | Uint8Array,
    options?: UploadOptions
  ): Promise<ApiResult<StorageFile>> {
    // Reject path traversal (`..`) and null bytes before the path reaches the
    // server (it is sent as the `path` form field below).
    const invalid = validatePath(path);
    if (invalid) return invalid as ApiResult<StorageFile>;

    const formData = new FormData();

    // Normalize to a typed Blob. `File`/`Blob`, `ArrayBuffer`, typed arrays
    // and Node `Buffer`s (a `Uint8Array`) are all valid `BlobPart`s — no
    // Node-only global is referenced, so this is safe in the browser. The type
    // becomes the part's Content-Type, which the API stores as the MIME type.
    const type = options?.contentType || (file instanceof Blob && file.type) || guessContentType(path) || 'application/octet-stream';
    const blob = new Blob([file as BlobPart], { type });

    formData.append('file', blob, path.split('/').pop() || 'file');
    formData.append('path', path);
    if (options?.upsert) {
      formData.append('upsert', 'true');
    }

    // Storage upload bypasses the JSON HttpClient helper because it sends
    // multipart/form-data, not JSON. We still must use the absolute URL
    // (baseUrl + basePath) — Node's fetch rejects relative URLs.
    const url = this.absoluteUrl(`${this.basePath}/upload`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await this.client.authFetch(url, {
        method: 'POST',
        body: formData,
        // Fail loudly on unexpected redirects rather than silently forwarding
        // the Authorization header to the redirect target.
        redirect: 'error',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        return {
          data: null,
          error: {
            message: errorMessage(data, response.status, 'Upload failed'),
            code: data?.code,
            status: response.status,
            details: data ?? undefined,
          },
        };
      }

      // Controller wraps the result as `{ data, error: null }` — unwrap to
      // the StorageFile payload to match the rest of the SDK's return shape.
      return { data: (data?.data ?? data) as StorageFile, error: null };
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === 'AbortError') {
        return { data: null, error: { message: 'Upload timeout', code: 'TIMEOUT' } };
      }
      return {
        data: null,
        error: {
          message: err instanceof Error ? err.message : 'Upload failed',
          code: 'UPLOAD_ERROR',
        },
      };
    }
  }

  /**
   * Download a file from the bucket.
   *
   * Calls `GET /api/project/{slug}/storage/{bucket}/download/{path}` and
   * returns the response body as a Blob.
   */
  async download(path: string): Promise<ApiResult<Blob>> {
    const invalid = validatePath(path);
    if (invalid) return invalid as ApiResult<Blob>;

    // Encode each segment (preserving `/` separators) so the path can't inject
    // URL syntax or traverse outside the bucket.
    const url = this.absoluteUrl(`${this.basePath}/download/${encodeStoragePath(path)}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await this.client.authFetch(url, {
        // Fail loudly on unexpected redirects rather than silently forwarding
        // the Authorization header to the redirect target.
        redirect: 'error',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        return {
          data: null,
          error: {
            message: errorMessage(body, response.status, 'Download failed'),
            code: body?.code,
            status: response.status,
            details: body ?? undefined,
          },
        };
      }

      const blob = await response.blob();
      return { data: blob, error: null };
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === 'AbortError') {
        return { data: null, error: { message: 'Download timeout', code: 'TIMEOUT' } };
      }
      return {
        data: null,
        error: {
          message: err instanceof Error ? err.message : 'Download failed',
          code: 'DOWNLOAD_ERROR',
        },
      };
    }
  }

  /**
   * Delete files from the bucket
   */
  async remove(paths: string[]): Promise<ApiResult<{ deleted: string[]; errors: string[] }>> {
    // Reject path traversal (`..`) and null bytes on every path before they
    // reach the server (paths are sent in the request body).
    for (const path of paths) {
      const invalid = validatePath(path);
      if (invalid) return invalid as ApiResult<{ deleted: string[]; errors: string[] }>;
    }
    return unwrapEnvelope(await this.client.request(this.basePath, {
      method: 'DELETE',
      body: { paths },
    }));
  }

  /**
   * List files in the bucket
   */
  async list(
    prefix?: string,
    options?: { limit?: number }
  ): Promise<ApiResult<StorageListItem[]>> {
    const params = new URLSearchParams();
    if (prefix) params.set('prefix', prefix);
    if (options?.limit) params.set('limit', options.limit.toString());

    const query = params.toString() ? `?${params.toString()}` : '';
    return unwrapEnvelope(await this.client.request(`${this.basePath}${query}`));
  }

  /**
   * Get the public URL for a file. Routes through the anonymous public-storage
   * controller mounted at `/api/public/:slug/storage/:bucket/*path` — no
   * Authorization header is required. Use this for files in public buckets.
   *
   * Pass `transform` to request an on-the-fly image rendition (resize/format):
   *
   * ```ts
   * storage.from('avatars').getPublicUrl('u/1.png', {
   *   transform: { width: 128, height: 128, format: 'webp', quality: 80 },
   * });
   * ```
   */
  getPublicUrl(path: string, options?: { transform?: ImageTransformOptions }): { data: { publicUrl: string } } {
    // This method is synchronous and can't return an ApiResult error, so a
    // traversal/null-byte attempt throws (it's a caller bug or attack, not a
    // recoverable runtime error).
    const invalid = validatePath(path);
    if (invalid) {
      throw new Error(`NestCore: ${invalid.error?.message ?? 'invalid storage path'}`);
    }

    const baseUrl = this.client.getBaseUrl();
    const projectSlug = this.client.getProjectSlug();
    // Encode each path segment (preserving `/` separators) so the path can't
    // inject URL syntax or traverse outside the bucket.
    let publicUrl = `${baseUrl}/api/public/${projectSlug}/storage/${this.bucket}/${encodeStoragePath(path)}`;

    const qs = buildTransformQuery(options?.transform);
    if (qs) publicUrl += `?${qs}`;

    return {
      data: { publicUrl },
    };
  }

  /**
   * Create the bucket if it doesn't exist (requires a service_role key).
   * `public` is sent only when given, so an "ensure bucket" call leaves an
   * existing bucket's visibility unchanged; new buckets default to private.
   */
  async createBucket(
    options: { public?: boolean } = {},
  ): Promise<ApiResult<{ bucket: string; created: boolean }>> {
    return unwrapEnvelope(await this.client.request(
      `${this.basePath}/create`,
      { method: 'POST', body: options.public === undefined ? undefined : { public: options.public } }
    ));
  }
}
