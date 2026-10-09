# Excalidraw authenticated storage

> [!IMPORTANT]
> This repository is a customized fork of the original [Excalidraw project](https://github.com/excalidraw/excalidraw), created and maintained by the Excalidraw contributors. It is not the upstream Excalidraw repository. This fork embeds the `@excalidraw/excalidraw` package and adds authentication and server-side, per-user diagram storage.

## Overview

This self-hosted deployment combines Excalidraw with:

- a React and Vite frontend;
- an Express backend with login and PostgreSQL-backed sessions;
- per-user diagram storage in PostgreSQL;
- JSON backup copies under the runtime `data/` directory;
- administrator-only user management for the account named `admin`; and
- authenticated prompt-to-diagram generation through OpenRouter with Groq fallback; and
- a Docker image and Docker Compose configuration.

## Project structure

- `app/`: React frontend, Express server, and Node.js package metadata
- `db/001_init.sql`: PostgreSQL schema bootstrap
- `db/create-user.example.sql`: example user-provisioning statement
- `docker-compose.yml`: container configuration
- `Dockerfile`: production image build
- `data/`: generated diagram backups, mounted by Docker and ignored by Git

## Run with Docker Compose

### Prerequisites

- Docker with Docker Compose

The Compose stack starts two services: the Excalidraw application and an internal PostgreSQL 16 database with persistent storage. Its checked-in `PGPASSWORD` and `SESSION_SECRET` values are development-only defaults; replace them with secret-managed values before any production deployment.

Create `app/.env` with one or both provider keys. This file is ignored by Git and Compose passes its values to the application container at runtime; the keys are not embedded in the repository or image:

```dotenv
OPENROUTER_API_KEY=your-openrouter-api-key
GROQ_API_KEY=your-groq-api-key
GROQ_MODEL=openai/gpt-oss-20b
```

From the repository root, start the stack with that environment file:

```powershell
docker compose --env-file app/.env up -d --build
```

The application is then available at <http://localhost:3030>.

PostgreSQL is not published to the host. Compose waits for the database health check before starting the application, and the server then creates the configured schema and required tables. The equivalent bootstrap SQL is available in `db/001_init.sql`.

## Local build and development

The application requires Node.js and a reachable PostgreSQL instance. The production container uses Node.js 22.

From `app/`, install dependencies and run the available checks:

```powershell
npm ci
npm test
npm run lint
npm run build
```

To run the built frontend through the Express server, configure the environment and start the server:

```powershell
$env:PGHOST = "127.0.0.1"
$env:PGPORT = "5432"
$env:PGDATABASE = "postgres"
$env:PGUSER = "postgres"
$env:PGPASSWORD = "replace-me"
$env:PGSCHEMA = "excalidraw"
$env:SESSION_SECRET = "replace-with-a-long-random-secret"
$env:OPENROUTER_API_KEY = "your-openrouter-api-key"
$env:GROQ_API_KEY = "your-groq-api-key"
$env:GROQ_MODEL = "openai/gpt-oss-20b"
npm start
```

`npm run dev` starts the Vite frontend development server. The checked-in Vite configuration does not define a proxy for the backend API, so full authenticated operation requires routing `/api` requests to the Express server or using the build-and-start workflow above.

## Configuration

The server reads these environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3030` | Express HTTP port |
| `DATA_DIR` | `../data` relative to `app/` | JSON backup directory |
| `PGHOST` | `127.0.0.1` | PostgreSQL host |
| `PGPORT` | `5432` | PostgreSQL port |
| `PGDATABASE` | `postgres` | PostgreSQL database |
| `PGUSER` | `postgres` | PostgreSQL user |
| `PGPASSWORD` | `postgres` | PostgreSQL password; replace this default |
| `PGSCHEMA` | `excalidraw` | PostgreSQL schema |
| `PGSSL` | `false` | Enable PostgreSQL TLS when set to `true` |
| `SESSION_SECRET` | `change-me-in-production` | Session-signing secret; replace this default |
| `OPENROUTER_API_KEY` | none | Server-only OpenRouter credential required for AI generation |
| `GROQ_API_KEY` | none | Server-only Groq credential used when OpenRouter is unavailable |
| `GROQ_MODEL` | `openai/gpt-oss-20b` | Validated server-side Groq model override |
| `GROQ_MODELS` | none | Optional comma-separated Groq fallback chain; completely replaces the compiled default chain and overrides `GROQ_MODEL` when non-empty |

Docker Compose overrides some server defaults; treat `docker-compose.yml` as the source of truth for the container deployment.

## Authentication and storage

- Users authenticate with bcrypt password hashes stored in PostgreSQL.
- Sessions are stored in PostgreSQL by `connect-pg-simple` and use the `excalidraw.sid` cookie.
- Diagram queries are scoped to the authenticated user's database ID.
- Saving a diagram upserts its scene in PostgreSQL and writes a `.excalidraw.json` backup to `data/<username>/`.
- Deleting a user also deletes that user's diagrams through the database relationship and removes the user's backup directory.
- The account whose username is exactly `admin` receives the user-management interface and API permissions.

## Generate a diagram with AI

1. Configure `OPENROUTER_API_KEY`, `GROQ_API_KEY`, or both in `app/.env` and restart the application with `docker compose --env-file app/.env up -d --build`.
2. Open the Excalidraw main menu and select **Generate with AI**.
3. Describe a flowchart and select **Generate diagram**.

The browser calls only the authenticated local endpoint. The server first requests OpenRouter's `openrouter/free` model. If OpenRouter is unconfigured or has an eligible provider, quota, rate-limit, timeout, or transient failure, the same validated request moves through this default Groq chain:

1. `openai/gpt-oss-20b`
2. `openai/gpt-oss-120b`
3. `qwen/qwen3.6-27b`
4. `qwen/qwen3.8-27b`

These four IDs are compiled defaults in `app/openrouter.mjs`; the application does not discover or refresh Groq models automatically. Groq availability is account-specific and can change, so treat this list as a safe fallback rather than a guarantee that every model is enabled for every account.

`GROQ_MODEL` remains backward compatible as the preferred first model, followed by the remaining compiled defaults. A valid, non-empty `GROQ_MODELS` defines the complete ordered chain instead. Both forms are deduplicated and capped at four validated model IDs. Invalid configuration stops before any provider request.

For example, this `app/.env` value replaces the compiled chain and tries only the listed models in this order:

```dotenv
GROQ_MODELS=openai/gpt-oss-20b,openai/gpt-oss-120b
```

Each Groq attempt has its own timeout and the whole Groq chain has a shared deadline, so unavailable models cannot multiply the wait indefinitely. Credential rejection stops the chain immediately; model availability, provider, rate-limit, timeout, and malformed-output failures may continue to the next model. Invalid prompts are never sent to either provider. Returned Mermaid is validated before the browser converts it to Excalidraw elements beside the existing scene.

The Qwen models are preview models according to Groq documentation and may change or be removed. For production, set `GROQ_MODELS` to only the models your organization has explicitly approved and verified for its Groq account.

Generation is limited to five user requests per minute in each running application instance. A Groq fallback attempt remains part of the same user request and does not consume another quota unit. Both providers may apply additional rate limits.

Do not put either key in frontend variables, source files, Dockerfiles, Compose values, or committed `.env` files. For production, inject them through your deployment platform's secret manager. Closing the dialog while a request is running cancels the browser request; server and provider timeouts remain independently bounded.

## Export a diagram to Mermaid

1. Save a new diagram to the server or load an existing one so its current server name is active.
2. Open the Excalidraw main menu and select **Save to...**.
3. In the **Mermaid** card, select **Export to Mermaid**.

The browser downloads a UTF-8 `.mmd` file using the current server diagram name. For example, a diagram saved or loaded as `deployment-flow` is exported as `deployment-flow.mmd`. Unsafe filename characters and duplicate `.mmd` suffixes are removed; an unnamed or invalid name falls back to `diagram.mmd`.

The exporter preserves semantic flowchart topology rather than the exact canvas layout. It converts supported rectangles, ellipses, diamonds, bound labels, and bound arrows or lines. Unsupported, unbound, deleted, or dangling elements are omitted and reported in an Excalidraw notification. Styling, freehand drawings, images, frames, groups, exact positions, and connector bends do not have reliable Mermaid equivalents and are not preserved.

## Create the first user

After running `npm ci` in `app/`, generate a bcrypt hash:

```powershell
npm run hash-password -- your-password
```

Copy `db/create-user.example.sql`, replace its example username, hash, and display name, then execute the resulting statement against the configured PostgreSQL database. To enable administration, create a user whose username is exactly `admin`.

## Upstream attribution and license

This fork is distributed under the **MIT License**. It is based on and embeds [Excalidraw](https://github.com/excalidraw/excalidraw), whose original source code and `@excalidraw/excalidraw` package are also licensed under the MIT License; see the [upstream Excalidraw license](https://github.com/excalidraw/excalidraw/blob/master/LICENSE).

Third-party dependencies remain subject to their respective licenses. The root `LICENSE` file carries the MIT terms for this fork's custom code together with the upstream Excalidraw notice, so the terms travel with the source.
