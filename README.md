# @orbitneststudio/js

The official **browser/JavaScript SDK** for the [OrbitNest](https://orbitnest.io)
platform — auth, database, a Supabase-style query builder, storage, realtime,
and edge functions, for web apps (React, Vue, Svelte, vanilla, …).

This is the client-side counterpart to [`@orbitneststudio/node`](https://github.com/Orbitnest/orbitnest_node):
the same API surface, packaged for the browser (ESM, CJS, and a CDN/IIFE bundle),
with session persistence and no Node-only dependencies.

```bash
npm install @orbitneststudio/js
```

Or drop it in over a CDN — the global is `OrbitNest`:

```html
<script src="https://cdn.jsdelivr.net/npm/@orbitneststudio/js"></script>
<script>
  const orbit = OrbitNest.createClient({ apiKey: 'YOUR_ANON_KEY' });
</script>
```

> Use your project's **publishable anon key** in client-side code. Never ship a
> service-role key to the browser — it bypasses row-level security.

---

## Quick start

```ts
import { createClient, localStorageAdapter } from '@orbitneststudio/js';

const orbit = createClient({
  apiKey: import.meta.env.VITE_ORBITNEST_ANON_KEY,
  storage: localStorageAdapter, // keep the user signed in across page reloads
});

// Query with the fluent builder
const { data, error } = await orbit.db
  .from('posts')
  .eq('published', true)
  .order('created_at', { ascending: false })
  .limit(10)
  .select();

// Auth
await orbit.auth.signIn({ email, password });
const user = orbit.auth.getUser();

// Realtime
const channel = orbit.channel('orders')
  .on('postgres_changes', { event: 'INSERT', table: 'orders' }, (e) => console.log('new order', e.new))
  .subscribe();
```

The project slug is read from the API key's JWT, and `baseUrl` defaults to
`https://api.orbitnest.io` — so `apiKey` is usually all you need. Pass `baseUrl`
for local dev.

---

## What's included

`createClient()` returns a client with these namespaces:

| Namespace | What it does |
| --- | --- |
| `db` | Raw SQL (`db.query`), table CRUD, RLS policy management, and the fluent query builder via `db.from(table)`. |
| `auth` | Email/password, email OTP, password recovery, profile, and **passkeys/WebAuthn**. Sessions persist via the configured storage adapter. |
| `storage` | `storage.from(bucket)` → `upload` / `download` / `list` / `remove` / `getPublicUrl`. |
| `realtime` / `channel()` | Postgres change subscriptions, broadcast, and presence over WebSocket. |
| `functions` | `functions.invoke(name, { body })` to call edge functions. |
| `jobs`, `env`, `logs` | Deprecated: these need a Studio admin token, so with a project key every call returns an `ADMIN_ONLY` error. Use Studio, the CLI or the MCP server. |
| `analytics` | `identify` / `track` / `screen` / `crash`, with batched ingest. |

### The query builder

`db.from(table)` returns a chainable, **parameterized** builder (every value is
bound, never interpolated) that mirrors `@orbitneststudio/node` and Supabase:

```ts
orbit.db.from('users')
  .eq('role', 'admin')          // also: neq, gt, gte, lt, lte, like, ilike, in, is
  .order('created_at', { ascending: false })
  .range(0, 19)                 // or .limit(n) / .page(n, size)
  .select('id, email, role');   // → { data: { rows, total }, error }

await orbit.db.from('users').eq('id', id).single();      // exactly one row
await orbit.db.from('users').eq('id', id).maybeSingle(); // one row or null

await orbit.db.from('posts').insert({ title: 'Hi' });
await orbit.db.from('posts').update(id, { title: 'Edited' });
await orbit.db.from('posts').delete(id);
```

Every call returns `{ data, error }` — check `error` before using `data` (the
SDK never throws on API errors).

---

## Session persistence

By default the session lives only in that client instance (safe for SSR: one
client per request never sees another request's user). Pass a storage adapter
to persist it:

```ts
import { createClient, localStorageAdapter, createMemoryAdapter } from '@orbitneststudio/js';

createClient({ apiKey, storage: localStorageAdapter }); // survives refresh
createClient({ apiKey, storage: createMemoryAdapter() }); // in-memory store you can share deliberately
```

`localStorageAdapter` persists nothing when `localStorage` is unavailable (SSR,
private mode), so it's always safe to pass — on a server each client keeps its
own session.
You can also supply your own adapter — any object with
`getItem` / `setItem` / `removeItem`:

```ts
import type { StorageAdapter } from '@orbitneststudio/js';

const sessionStorageAdapter: StorageAdapter = {
  getItem: (k) => sessionStorage.getItem(k),
  setItem: (k, v) => sessionStorage.setItem(k, v),
  removeItem: (k) => sessionStorage.removeItem(k),
};
```

Persisted sessions are namespaced per project, so multiple clients on the same
origin don't collide.

---

### Calling auth from your server

Auth endpoints are throttled per client IP. When your server calls them for its users (a Next.js server action, an API route), every user would share your server's IP and its limit. Pass the user's IP with the **service-role key** and each user gets their own bucket; the same IP goes into the auth audit log:

```ts
const client = createClient({
  apiKey: process.env.ORBITNEST_SERVICE_ROLE_KEY!, // never ship this key to a browser
  clientIp: userIp, // e.g. the first address of x-forwarded-for set by YOUR proxy
});
await client.auth.signIn({ email, password });
```

`clientIp` is sent as `X-OrbitNest-Client-IP` and must be a single IPv4 or IPv6 address. The API ignores it on requests made with the anon key or a user token, so a browser can't choose its own bucket. Create one client per request.

Project auth answers `429` with a `code` when a limit from the project's auth settings is reached: `OTP_RATE_LIMITED` (too many wrong codes), `OTP_REQUEST_LIMIT` (too many codes requested for one email in an hour), `ACCOUNT_LOCKED` (too many wrong passwords).

## AI

Chat, streaming, tool calls and embeddings through the project's own provider keys (Studio → Project Settings → AI). Calls need a signed-in user or the service-role key.

```ts
const { data } = await client.ai.chat({ messages: [{ role: 'user', content: 'Summarise my last order' }] });

for await (const ev of client.ai.chatStream({ messages })) {
  if (ev.type === 'delta') process.stdout.write(ev.text);
  if (ev.type === 'error') console.error(ev.code, ev.message);
}

const { data: vectors } = await client.ai.embed(['first', 'second']); // 768 dimensions
```

Tools: pass `tools: [{ name, description, parameters }]`; run each of `data.toolCalls`, then send the reply back as `{ role: 'assistant', content: null, toolCalls }` plus one `{ role: 'tool', toolCallId, content }` per call. See https://orbitnest.io/docs/ai-gateway.

## Realtime

Browsers can't set WebSocket request headers, so the API key is sent via the
connection subprotocol (never in the URL — it would leak into logs/history). In
the browser the SDK uses the native `WebSocket`; for isomorphic/SSR use on
Node.js < 22, pass one:

```ts
import WebSocket from 'ws';
createClient({ apiKey, realtimeOptions: { WebSocket } });
```

```ts
const channel = orbit.channel('room-1')
  .on('broadcast', { event: 'cursor' }, (msg) => render(msg.payload))
  .on('postgres_changes', { event: '*', table: 'messages' }, (e) => append(e.new))
  .subscribe((status) => console.log(status));

channel.send('cursor', { x, y });
channel.presence.track({ user: 'me' });
```

---

## TypeScript types from your schema

Generate row types from the live schema for end-to-end safety (typically run
server-side / in a build step, since it needs a service-role key):

```ts
import { generateTypes } from '@orbitneststudio/js';
const ts = await generateTypes(serverClient.db); // → string of TS interfaces + a `Database` map
```

> Prefer the [`orbitnest` CLI](https://github.com/Orbitnest/orbitnest_cli)'s
> `orbitnest gen types` for this in projects.

---

## Browser support

Targets ES2020 and any environment with `fetch`, `WebSocket`, `FormData`, and
`Blob` (all modern browsers; Node 18+ for isomorphic use). No polyfills needed.

`@orbitneststudio/node` vs `@orbitneststudio/js`: the Node SDK additionally ships a
filesystem-backed **migration runner**; the web SDK omits it (no filesystem in
the browser) and adds **session persistence adapters**. Everything else is the
same API.

---

## Development

```bash
npm install
npm run build      # → dist/ : ESM (.mjs), CJS (.js), IIFE (.global.js), + .d.ts
npm run typecheck
```

---

## License

MIT © OrbitNest
