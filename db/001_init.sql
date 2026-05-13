CREATE SCHEMA IF NOT EXISTS excalidraw;

CREATE TABLE IF NOT EXISTS excalidraw.users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE excalidraw.users
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS excalidraw.diagrams (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES excalidraw.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  scene_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT diagrams_user_name_unique UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS diagrams_user_updated_idx
  ON excalidraw.diagrams (user_id, updated_at DESC);
