/**
 * Pluggable key/value storage for persisting the auth session across page
 * loads. A browser app typically wants `localStorageAdapter` so a signed-in
 * user stays signed in after a refresh. Without an adapter the session lives
 * only in that client instance — the right choice for SSR (one client per
 * request) or when you manage tokens yourself.
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
      const probe = '__nestcore_probe__';
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

/**
 * Non-persisting adapter: the session lives only in the client instance that
 * holds it. Shared module-level state here would leak one user's session into
 * every other client in an SSR process, so this stores nothing.
 */
export const memoryAdapter: StorageAdapter = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};

/**
 * Browser `localStorage`, resolved on each call. Where `localStorage` is
 * unavailable (SSR, private mode) it persists nothing, so on a server every
 * client keeps its session to itself instead of sharing one in-memory store.
 */
export const localStorageAdapter: StorageAdapter = {
  getItem: (k) => {
    try { return usableLocalStorage()?.getItem(k) ?? null; } catch { return null; }
  },
  setItem: (k, v) => {
    try { usableLocalStorage()?.setItem(k, v); } catch { /* quota / private mode */ }
  },
  removeItem: (k) => {
    try { usableLocalStorage()?.removeItem(k); } catch { /* ignore */ }
  },
};

function usableLocalStorage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}
