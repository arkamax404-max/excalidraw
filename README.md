# Excalidraw authenticated storage

Customized self-hosted Excalidraw deployment with user authentication, PostgreSQL persistence, and per-user diagram isolation.

## What this project includes

- Excalidraw embedded in a custom React app
- Express backend with login, sessions, and per-user diagram storage
- Dockerized deployment
- PostgreSQL-backed users, sessions, and diagrams
- Optional JSON backup copies in the runtime `data/` folder
- Apache reverse proxy publication through `excalidraw.arkamax.es`

## Project structure

- `docker-compose.yml`: container orchestration
- `Dockerfile`: production image build
- `app/`: frontend and backend application
- `db/`: SQL bootstrap and admin helpers
- `data/`: runtime backup copies of diagrams

## Run

```powershell
cd C:\docker\excalidraw
docker compose up -d --build
```

Application URL:

- `http://localhost:3030`

## Features added on top of standard Excalidraw

- Login required before entering the editor
- Per-user diagram isolation
- Save diagrams to PostgreSQL
- Load diagrams from PostgreSQL
- Delete diagrams from PostgreSQL
- Compact storage panel integrated into the top bar
- Dedicated logout action inside the storage panel
- Display name shown in the storage panel instead of the raw username
- Admin-only user management from the Excalidraw hamburger menu
- JSON backup copies written to `data\<username>\`

## PostgreSQL configuration

Current deployment values:

- external host: `192.168.1.222`
- port: `5433`
- database: `postgres`
- user: `postgres`
- schema: `excalidraw`

The container connects to the same PostgreSQL host through `host.docker.internal`. Replace the default password and `SESSION_SECRET` before production use.

## Authentication flow

- Users are created manually in PostgreSQL
- Passwords are stored as bcrypt hashes
- Sessions are stored in PostgreSQL through `connect-pg-simple`
- The application uses the `excalidraw.sid` cookie for authenticated requests
- Users support `display_name` and `last_login_at`

## Admin user management

- If the logged-in user is `admin`, the hamburger menu shows a user management entry
- Admins can create, edit, deactivate, and delete users
- The admin panel shows each user's last login timestamp and diagram count
- The login session stores whether the authenticated user has admin privileges

## Manual user provisioning

Generate a password hash:

```powershell
cd C:\docker\excalidraw\app
npm run hash-password -- your-password
```

Then insert the user manually with the generated hash using `db\create-user.example.sql` as a template.

## Reverse proxy

Apache/XAMPP publishes the service at:

- `https://excalidraw.arkamax.es`

The vhost proxies traffic to the local container on `http://127.0.0.1:3030`.

## Notes

- Diagrams are stored in PostgreSQL and also written as `.excalidraw.json` backup copies under `data/<username>/`.
- The `data/` runtime folder is ignored from git.
- For internet publishing, Apache proxies `excalidraw.arkamax.es` to the local container.
