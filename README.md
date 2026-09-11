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
- A PostgreSQL instance reachable from the container

Review `docker-compose.yml` before starting. Its checked-in values target PostgreSQL through `host.docker.internal` on port `5433` and include development-only defaults for `PGPASSWORD` and `SESSION_SECRET`. Replace those secrets before any production deployment.

From the repository root, run:

```powershell
docker compose up -d --build
```

The application is then available at <http://localhost:3030>.

The server creates the configured PostgreSQL schema and required tables on startup. The equivalent bootstrap SQL is available in `db/001_init.sql`.

## Local build and development

The application requires Node.js and a reachable PostgreSQL instance. The production container uses Node.js 22.

From `app/`, install dependencies and run the available checks:

```powershell
npm ci
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

Docker Compose overrides some server defaults; treat `docker-compose.yml` as the source of truth for the container deployment.

## Authentication and storage

- Users authenticate with bcrypt password hashes stored in PostgreSQL.
- Sessions are stored in PostgreSQL by `connect-pg-simple` and use the `excalidraw.sid` cookie.
- Diagram queries are scoped to the authenticated user's database ID.
- Saving a diagram upserts its scene in PostgreSQL and writes a `.excalidraw.json` backup to `data/<username>/`.
- Deleting a user also deletes that user's diagrams through the database relationship and removes the user's backup directory.
- The account whose username is exactly `admin` receives the user-management interface and API permissions.

## Create the first user

After running `npm ci` in `app/`, generate a bcrypt hash:

```powershell
npm run hash-password -- your-password
```

Copy `db/create-user.example.sql`, replace its example username, hash, and display name, then execute the resulting statement against the configured PostgreSQL database. To enable administration, create a user whose username is exactly `admin`.

## Upstream attribution and license

This fork is distributed under the **MIT License**. It is based on and embeds [Excalidraw](https://github.com/excalidraw/excalidraw), whose original source code and `@excalidraw/excalidraw` package are also licensed under the MIT License; see the [upstream Excalidraw license](https://github.com/excalidraw/excalidraw/blob/master/LICENSE).

Third-party dependencies remain subject to their respective licenses. A root `LICENSE` file should accompany this repository so the MIT terms for its custom code are available with the source.
