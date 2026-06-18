/**
 * Pluggable key/value storage for persisting the auth session across page
 * loads. A browser app typically wants `localStorageAdapter` so a signed-in
 * user stays signed in after a refresh; pass `memoryAdapter` (the default) for
 * ephemeral sessions, SSR, or when you manage tokens yourself.
 */
export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** In-memory storage — sessions live only for the lifetime of the tab/process. */
export function createMemoryAdapter(): StorageAdapter {
  const store = new Map<string, string>();
  return {
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    setItem: (k, v) => void store.set(k, v),
    removeItem: (k) => void store.delete(k),
  };
}

/**
 * Browser `localStorage`-backed storage. Falls back to in-memory automatically
 * when `localStorage` is unavailable or throws (SSR, private-mode, quota), so
 * it's always safe to pass.
 */
export function createLocalStorageAdapter(): StorageAdapter {
  let ls: Storage | null = null;
  try {
    ls = typeof globalThis !== 'undefined' ? (globalThis as { localStorage?: Storage }).localStorage ?? null : null;
    // Probe — Safari private mode exposes localStorage but throws on write.
    if (ls) {
      const probe = '__orbitnest_probe__';
      ls.setItem(probe, '1');
      ls.removeItem(probe);
    }
  } catch {
    ls = null;
  }
  if (!ls) return createMemoryAdapter();

  const storage = ls;
  return {
    getItem: (k) => {
      try {
        return storage.getItem(k);
      } catch {
        return null;
      }
    },
    setItem: (k, v) => {
      try {
        storage.setItem(k, v);
      } catch {
        /* ignore quota / private-mode errors */
      }
    },
    removeItem: (k) => {
      try {
        storage.removeItem(k);
      } catch {
        /* ignore */
      }
    },
  };
}

/** Shared singleton adapters for convenient import. */
export const memoryAdapter: StorageAdapter = createMemoryAdapter();
export const localStorageAdapter: StorageAdapter = createLocalStorageAdapter();
