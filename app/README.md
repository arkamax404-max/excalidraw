# Application (frontend and server)

The React frontend and the Express server of this self-hosted Excalidraw fork. See
the repository root `README.md` for the deployment overview, the Compose workflow and
the full environment-variable table.

- `src/`: React frontend (Excalidraw embedded through `@excalidraw/excalidraw`), the
  AI prompt dialog, and the Mermaid conversion and export helpers.
- `server.mjs`: Express server: session login, per-user diagram storage, JSON backups
  and the AI generation endpoint.
- `openrouter.mjs`: OpenRouter request with the validated Groq fallback chain.
- `dist/`: built frontend, served by the Express server.
- `scripts/hash-password.mjs`: bcrypt hash generator for provisioning users.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm ci` | Install dependencies exactly as locked |
| `npm run dev` | Vite development server for the frontend |
| `npm run build` | Build the frontend into `dist/` |
| `npm run lint` | ESLint over the project |
| `npm test` | `node --test` over the server and helper tests |
| `npm run test:api` | HTTP authentication/storage regression tests with disposable Docker PostgreSQL (requires Bash, Docker and `npm ci`) |
| `npm start` | Run `server.mjs` (expects a reachable PostgreSQL instance) |
| `npm run hash-password -- <password>` | Print a bcrypt hash for `db/create-user.example.sql` |

The Vite development server defines no proxy for the backend API, so authenticated
operation requires either routing `/api` to the Express server or the build-and-start
workflow:

```powershell
npm run build
npm start
```

## Isolated API tests

After `npm ci`, run `npm run test:api` from `app/`. The runner uses
`postgres:16-alpine` and `node:22-alpine`, creates a unique internal Docker network
and a disposable database with temporary storage, and mounts the application
read-only. It publishes no ports, ignores local database/provider configuration,
and removes its containers and network on exit. Existing application containers,
users, database volumes and backups are not touched.

The tests start the real server and cover sessions, login/logout, private diagram
save/list/load/overwrite/delete, JSON backups, user isolation and rejected saves.
Database access is used only to provision fixtures; behavior is checked through
HTTP and backup files. `npm test` remains the fast suite without Docker. Running
the integration file directly is intentionally rejected: use the isolated runner.

`tests/helpers/persistence-fixture.mjs` supplies isolated accounts, real HTTP requests
and public-state/backup snapshots for `tests/persistence.integration.mjs`. These
regressions pin legacy raw-scene writes, revision tokens, shared reads and rejection
non-effects. This test foundation adds no guarded save endpoint or lost-update
protection; legacy replacements still accept writes without `If-Match`.

## HTTP API

The server exposes the session cookie `excalidraw.sid`; every route below except the
authentication routes requires an authenticated session.

| Route | Purpose |
| --- | --- |
| `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session` | Session lifecycle |
| `GET/POST/PUT/DELETE /api/admin/users` | User management; requires the account named exactly `admin` |
| `GET /api/files`, `GET/PUT/DELETE /api/files/:name` | Per-user diagram storage; `PUT` takes the raw scene object |
| `GET /api/diagrams`, `GET /api/diagrams/:id` | Owner/member stable-ID discovery and loading (contracts below) |
| `PUT /api/diagrams/:id` | Guarded owner/member raw-scene replacement with identity-bearing `If-Match` |
| `GET/POST /api/diagrams/:id/members`, `DELETE /api/diagrams/:id/members/:username` | Owner-only membership administration |
| `POST /api/ai/diagram` | Prompt to Mermaid through OpenRouter with the Groq fallback chain |

Diagram names are normalized server-side: NFKC, runs of characters outside
`[\w\- ]` and whitespace runs become `-`, leading and trailing `[-_. ]` are stripped,
the result is lowercased, truncated to 80 characters, and an empty result becomes
`diagrama-1`.

### Stable-ID reads

`GET /api/diagrams` returns `{ diagrams: [...] }`, containing only the caller's
owned and actively joined diagrams, ordered by `updatedAt` descending, then ID descending. Each item is
`{ id, revision, name, fileName, updatedAt }`; `id` and `revision` are canonical decimal **strings**, preserving the
full PostgreSQL BIGINT range. An empty account receives `{ diagrams: [] }`.

`GET /api/diagrams/:id` returns `{ diagram: { id, revision, name, fileName, updatedAt }, scene }`.
The scene is unchanged from the legacy load response. IDs must be canonical decimal
integers from `1` through `9223372036854775807`; leading zeros, signs, whitespace,
fractions and exponents are invalid. Invalid IDs return HTTP 400 with
`{ error: "El identificador de diagrama no es valido." }`. Missing and inaccessible
IDs both return HTTP 404 with `{ error: "El diagrama solicitado no existe." }`.
Both routes require a session (HTTP 401, `{ error: "Necesitas iniciar sesion." }`),
even for malformed IDs. Being `admin` does not bypass ownership checks.

These routes are read-only. Existing `/api/files` contracts and normalization are
unchanged: overwrite retains the ID, while delete followed by recreation assigns
a new ID. Membership never changes ownership; guarded ID replacement is described below.

### Revision foundation (T3a)

Each diagram has a positive PostgreSQL BIGINT revision, initially `1`. Existing
successful legacy replacements retain the ID and increment the revision exactly
once in SQL, even when the scene is identical. Neither IDs nor revisions pass
through JavaScript `Number`. Delete/recreate assigns a new ID with revision `1`.

Successful individual `GET /api/diagrams/:id`, `GET /api/files/:name`, and
`PUT /api/files/:name` responses carry the strong `ETag: "<id>:<revision>"` header,
for example `"9007199254740993:2"`. Owners and active members see the same token
on ID loads. List responses do not carry a document identity token. Legacy
successful JSON bodies, list shape and raw scene request format remain unchanged.

At revision `9223372036854775807`, a valid legacy replacement returns HTTP **409**
`{ error: "El diagrama ha alcanzado el limite de revisiones." }` without changing
the scene, revision, timestamp or backup. Invalid scenes still return the existing
400 error and change nothing. Other error contracts and access rules are unchanged.

Startup adds `revision BIGINT NOT NULL DEFAULT 1` and the named positive check
constraint to fresh or existing databases. Old rows receive revision `1` without
rewriting IDs, scenes or timestamps. SQL-managed deployments can reapply
`db/001_init.sql` or apply `db/003_diagram_revisions.sql` after their existing 001
(and 002 membership migration); both revision paths are idempotent. Substitute your
schema for `excalidraw` in standalone SQL. Backups remain raw scenes, not metadata.

**Incomplete feature:** legacy `/api/files` replacements remain blind and their
backups remain uncoordinated, including against guarded saves. Legacy guards and
frontend token handling await T3c; deletion/owner-directory failure ordering awaits
T3d. Legacy backup failures retain their old error behavior. T3 is not complete;
no global lost-update protection, cross-resource atomicity or durability is promised.

### Guarded stable-ID replacement (T3b)

`PUT /api/diagrams/:id` takes the raw full scene, including tombstones and files.
It never creates a missing ID, merges scenes, retries a canonical write or changes
ownership. Success is 200 `{ ok: true, diagram }`, with the same metadata shape as
ID reads and the new strong ETag; the exact BIGINT revision increases once.
Only a currently active database owner or active registered member may save;
`admin` has no bypass, and an existing session does not preserve revoked access.

Validation order is authentication, canonical ID, scoped database access (rechecked
after coordination), precondition, scene, then overflow. Errors return `{ error }`:

| Condition | Status and error |
| --- | --- |
| Missing `If-Match` | 428 `Debes indicar If-Match.` |
| Malformed `If-Match` | 400 `If-Match no es valido.` |
| Wrong identity or stale revision | 412 `La version del diagrama no coincide.` |

`If-Match` must be exactly one strong `"<id>:<revision>"` token. Both components
use the canonical positive BIGINT range documented above: weak tags, wildcard,
lists, zero, leading zeros, signs, fractions, exponents and out-of-range values
are rejected. HTTP framing whitespace is handled by the HTTP parser. Authentication,
ID, missing/inaccessible, scene and overflow errors retain their existing messages.
Inaccessible targets expose neither a document token nor precondition details.

The exercised `replaceDiagram` persistence boundary uses a dedicated PostgreSQL
session advisory lock keyed by stored owner ID and normalized stored name (with
schema namespace). It rechecks identity/access/revision under that lock, locks the
row, and performs a transactional CAS. Authorization linearizes at the UPDATE's
READ COMMITTED snapshot: a later revocation need not cancel an already authorized
save. Membership mutation code is unchanged. The session lock remains held through
commit and awaited backup completion, ordering participating guarded backups; the
backup username/name come from the stored owner join, never the acting member.
Rollback/error paths release the session; failed rollback/unlock destroys it.

If only backup writing fails after commit, return canonical success and the new
ETag with `X-Backup-Warning: diagram-backup-failed` and
`warning: "diagram-backup-failed"`; the server logs the failure without exposing
filesystem details to clients. Retrying the old token returns 412. A connection
loss during COMMIT can leave the outcome unknown: reload canonical data before a
user-directed retry; there is no blind retry or rollback guarantee for that case.
Backups have no fsync/crash-atomicity or repair-queue guarantee.

### Owner-controlled memberships

`GET /api/diagrams/:id/members` returns `{ members: [...] }`, ordered by username.
`POST` to that route accepts `{ username: "registered-account" }` and returns
201 `{ ok: true, member }`. Each member is `{ id, username, displayName, isAdmin }`,
with a string ID. `DELETE /api/diagrams/:id/members/:username` returns 200 `{ ok: true }`.
Usernames are trimmed, case-sensitive ASCII `[A-Za-z0-9._-]`, 3–50 characters;
POST requires a string. No role or ownership change is supported.

Authentication (401 above) precedes ID validation (400 above), diagram existence
(404 above), then ownership (403 `{ error: "Necesitas ser propietario del diagrama." }`).
Members and nonowner admins cannot administer memberships. After those checks:

| Condition | Status and JSON `error` |
| --- | --- |
| Invalid username | 400 `El usuario no es valido.` |
| Add or delete owner as member | 400 `El propietario no puede ser miembro.` |
| Add missing/inactive account | 404 `El usuario activo solicitado no existe.` |
| Duplicate grant | 409 `Ese usuario ya es miembro.` |
| Delete absent membership (including missing account) | 404 `La membresia solicitada no existe.` |

Only active registered members receive shared reads; revocation applies to the next
HTTP list/load, including existing sessions. Inactive memberships remain listed and
can be revoked, but confer no shared reads. Owners always retain access. Deleting a
member account removes its memberships, not others' diagrams; deleting an owner or
diagram cascades its memberships. Realtime eviction remains T4; guarded shared saves use the T3b route above.

### Membership migration

Server startup creates `diagram_members` and its user index additively for `PGSCHEMA`,
on fresh or existing databases; no scene/backups are rewritten and no grants are inferred.
For SQL-managed deployments, apply `db/001_init.sql`, then `db/002_collaboration.sql`
to the default `excalidraw` schema (substitute your schema for custom installations).
Both are idempotent. The composite primary key prevents duplicate grants; diagram
and user foreign keys use `ON DELETE CASCADE`. No destructive migration is required.
