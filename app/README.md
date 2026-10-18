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

## HTTP API

The server exposes the session cookie `excalidraw.sid`; every route below except the
authentication routes requires an authenticated session.

| Route | Purpose |
| --- | --- |
| `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session` | Session lifecycle |
| `GET/POST/PUT/DELETE /api/admin/users` | User management; requires the account named exactly `admin` |
| `GET /api/files`, `GET/PUT/DELETE /api/files/:name` | Per-user diagram storage; `PUT` takes the raw scene object |
| `GET /api/diagrams`, `GET /api/diagrams/:id` | Owner-only stable-ID discovery and loading (contracts below) |
| `POST /api/ai/diagram` | Prompt to Mermaid through OpenRouter with the Groq fallback chain |

Diagram names are normalized server-side: NFKC, runs of characters outside
`[\w\- ]` and whitespace runs become `-`, leading and trailing `[-_. ]` are stripped,
the result is lowercased, truncated to 80 characters, and an empty result becomes
`diagrama-1`.

### Stable-ID reads

`GET /api/diagrams` returns `{ diagrams: [...] }`, containing only the caller's
own diagrams, ordered by `updatedAt` descending, then ID descending. Each item is
`{ id, name, fileName, updatedAt }`; `id` is a decimal **string**, preserving the
full PostgreSQL BIGINT range. An empty account receives `{ diagrams: [] }`.

`GET /api/diagrams/:id` returns `{ diagram: { id, name, fileName, updatedAt }, scene }`.
The scene is unchanged from the legacy load response. IDs must be canonical decimal
integers from `1` through `9223372036854775807`; leading zeros, signs, whitespace,
fractions and exponents are invalid. Invalid IDs return HTTP 400 with
`{ error: "El identificador de diagrama no es valido." }`. Missing and other owners'
IDs both return HTTP 404 with `{ error: "El diagrama solicitado no existe." }`.
Both routes require a session (HTTP 401, `{ error: "Necesitas iniciar sesion." }`),
even for malformed IDs. Being `admin` does not bypass ownership checks.

These routes are read-only. Existing `/api/files` contracts and normalization are
unchanged: overwrite retains the ID, while delete followed by recreation assigns
a new ID. Memberships, sharing/revocation and shared saves are future slices;
there is no sharing or ID-oriented write endpoint yet.
