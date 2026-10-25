# @nestcore/js

The official **browser/JavaScript SDK** for the [NestCore](https://nestcore.io)
platform — auth, database, a Supabase-style query builder, storage, realtime,
and edge functions, for web apps (React, Vue, Svelte, vanilla, …).

This is the client-side counterpart to [`@nestcore/node`](https://github.com/Orbitnest/nestcore_node):
the same API surface, packaged for the browser (ESM, CJS, and a CDN/IIFE bundle),
with session persistence and no Node-only dependencies.

```bash
npm install @nestcore/js
```

Or drop it in over a CDN — the global is `NestCore` (the old `OrbitNest` global
still works as a deprecated alias):

```html
<script src="https://cdn.jsdelivr.net/npm/@nestcore/js"></script>
<script>
  const nestcore = NestCore.createClient({ apiKey: 'YOUR_ANON_KEY' });
</script>
```

> Use your project's **publishable anon key** in client-side code. Never ship a
> service-role key to the browser — it bypasses row-level security.

---

## Quick start

```ts
import { createClient, localStorageAdapter } from '@nestcore/js';

const nestcore = createClient({
  apiKey: import.meta.env.VITE_NESTCORE_ANON_KEY,
  storage: localStorageAdapter, // keep the user signed in across page reloads
});

// Query with the fluent builder
const { data, error } = await nestcore.db
  .from('posts')
  .eq('published', true)
  .order('created_at', { ascending: false })
  .limit(10)
  .select();

// Auth
await nestcore.auth.signIn({ email, password });
const user = nestcore.auth.getUser();

// Realtime
const channel = nestcore.channel('orders')
  .on('postgres_changes', { event: 'INSERT', table: 'orders' }, (e) => console.log('new order', e.new))
  .subscribe();
```

The project slug is read from the API key's JWT, and `baseUrl` defaults to
`https://api.nestcore.io` — so `apiKey` is usually all you need. Pass `baseUrl`
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
| `jobs`, `env`, `logs` | Deprecated: these need a NestCore console admin token, so with a project key every call returns an `ADMIN_ONLY` error. Use the console, the CLI or the MCP server. |
| `analytics` | `identify` / `track` / `screen` / `crash`, with batched ingest. |

### The query builder

`db.from(table)` returns a chainable, **parameterized** builder (every value is
bound, never interpolated) that mirrors `@nestcore/node` and Supabase:

```ts
nestcore.db.from('users')
  .eq('role', 'admin')          // also: neq, gt, gte, lt, lte, like, ilike, in, is
  .order('created_at', { ascending: false })
  .range(0, 19)                 // or .limit(n) / .page(n, size)
  .select('id, email, role');   // → { data: { rows, total }, error }

await nestcore.db.from('users').eq('id', id).single();      // exactly one row
await nestcore.db.from('users').eq('id', id).maybeSingle(); // one row or null

await nestcore.db.from('posts').insert({ title: 'Hi' });
await nestcore.db.from('posts').update(id, { title: 'Edited' });
await nestcore.db.from('posts').delete(id);
```

Every call returns `{ data, error }` — check `error` before using `data` (the
SDK never throws on API errors).

---

## Session persistence

By default the session lives only in that client instance (safe for SSR: one
client per request never sees another request's user). Pass a storage adapter
to persist it:

```ts
import { createClient, localStorageAdapter, createMemoryAdapter } from '@nestcore/js';

createClient({ apiKey, storage: localStorageAdapter }); // survives refresh
createClient({ apiKey, storage: createMemoryAdapter() }); // in-memory store you can share deliberately
```

`localStorageAdapter` persists nothing when `localStorage` is unavailable (SSR,
private mode), so it's always safe to pass — on a server each client keeps its
own session.
You can also supply your own adapter — any object with
`getItem` / `setItem` / `removeItem`:

```ts
import type { StorageAdapter } from '@nestcore/js';

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
  apiKey: process.env.NESTCORE_SERVICE_ROLE_KEY!, // never ship this key to a browser
  clientIp: userIp, // e.g. the first address of x-forwarded-for set by YOUR proxy
});
await client.auth.signIn({ email, password });
```

`clientIp` is sent as `X-NestCore-Client-IP` and must be a single IPv4 or IPv6 address. The API ignores it on requests made with the anon key or a user token, so a browser can't choose its own bucket. Create one client per request.

Project auth answers `429` with a `code` when a limit from the project's auth settings is reached: `OTP_RATE_LIMITED` (too many wrong codes), `OTP_REQUEST_LIMIT` (too many codes requested for one email in an hour), `ACCOUNT_LOCKED` (too many wrong passwords).

## AI

Chat, streaming, tool calls and embeddings through the project's own provider keys (Console → Project Settings → AI). Calls need a signed-in user or the service-role key.

```ts
const { data } = await client.ai.chat({ messages: [{ role: 'user', content: 'Summarise my last order' }] });

for await (const ev of client.ai.chatStream({ messages })) {
  if (ev.type === 'delta') process.stdout.write(ev.text);
  if (ev.type === 'error') console.error(ev.code, ev.message);
}

const { data: vectors } = await client.ai.embed(['first', 'second']); // 768 dimensions
```

Tools: pass `tools: [{ name, description, parameters }]`; run each of `data.toolCalls`, then send the reply back as `{ role: 'assistant', content: null, toolCalls }` plus one `{ role: 'tool', toolCallId, content }` per call. See https://nestcore.io/docs/ai-gateway.

### Memory, collections, threads, semantic search

```ts
// Memory: facts about the signed-in user (near-duplicates update the same memory)
await client.memory.add('Prefers vegetarian recipes', { kind: 'preference' });
const { data: mem } = await client.memory.search('what should I cook?'); // mem.degraded = keyword fallback

// Collections: documents chunked, embedded and searched (hybrid vector + keyword)
await admin.collections.create({ name: 'handbook' });                       // service-role key
await admin.collections.from('handbook').ingest({ url: 'https://example.com/guide.pdf' }, { wait: true });
const { data: hits } = await client.collections.from('handbook').search('How do refunds work?');

// Threads: saved conversations; replies stream and are stored as they arrive
const { data: thread } = await client.ai.threads.create({ title: 'Trip' });
for await (const ev of client.ai.threads.from(thread.id).run({ input: 'Plan a weekend', memory: true, collections: ['handbook'] })) {
  if (ev.type === 'delta') process.stdout.write(ev.text);
  if (ev.type === 'citation') console.log(`[${ev.index}]`, ev.title);
}

// Automatic embeddings (Console → AI → Embeddings), then search a table by meaning under RLS
const { data } = await client.db.from('articles').eq('published', true).semantic('body_embedding', 'reset my password', { k: 5 });
```

See https://nestcore.io/docs/memory-api, /docs/collections, /docs/threads and /docs/embeddings.

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
const channel = nestcore.channel('room-1')
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
import { generateTypes } from '@nestcore/js';
const ts = await generateTypes(serverClient.db); // → string of TS interfaces + a `Database` map
```

> Prefer the [`nestcore` CLI](https://github.com/Orbitnest/nestcore_cli)'s
> `nestcore gen types` for this in projects.

---

## Browser support

Targets ES2020 and any environment with `fetch`, `WebSocket`, `FormData`, and
`Blob` (all modern browsers; Node 22+ for isomorphic use). No polyfills needed.

`@nestcore/node` vs `@nestcore/js`: the Node SDK additionally ships a
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

## Migrating from `@orbitneststudio/js`

The SDK was renamed from OrbitNest to NestCore. Switch the dependency to
`@nestcore/js` and update your imports; nothing else has to change at once:

- The old export names still work as deprecated aliases: `OrbitNestError`
  (same class as `NestCoreError`, so `instanceof` checks keep working),
  `OrbitNestClient` and `OrbitNestConfig`.
- The default `baseUrl` is now `https://api.nestcore.io`.
- `clientIp` is now sent as `X-NestCore-Client-IP`.
- Sessions saved under the old `orbitnest.session.*` storage key and the
  analytics ids under `orbitnest_*` are moved to the new `nestcore` keys on
  first read, so signed-in users stay signed in.
- The CDN global `OrbitNest` is kept as an alias of `NestCore`.

---

## License

MIT © NestCore
