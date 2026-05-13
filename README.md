# Excalidraw local storage

Customized self-hosted Excalidraw deployment with server-side file storage.

## What this project includes

- Excalidraw embedded in a custom React app
- Express backend to list, save, load, and delete diagrams
- Dockerized deployment
- Persistent PostgreSQL-independent local file storage for diagrams
- Apache reverse proxy publication through `excalidraw.arkamax.es`

## Project structure

- `docker-compose.yml`: container orchestration
- `Dockerfile`: production image build
- `app/`: frontend and backend application
- `data/`: local diagram storage at runtime

## Local run

```powershell
cd C:\docker\excalidraw
docker compose up -d --build
```

Application URL:

- `http://localhost:3030`

## Features added on top of standard Excalidraw

- Save diagrams to the server
- Load saved diagrams from the server
- Delete saved diagrams from the server
- Compact storage panel integrated into the top bar

## Notes

- Diagrams are stored as `.excalidraw.json` files.
- The `data/` runtime folder is ignored from git.
- For internet publishing, Apache proxies `excalidraw.arkamax.es` to the local container.
