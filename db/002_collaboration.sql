-- Additive and safe to reapply; run after 001_init.sql on existing installations.
CREATE TABLE IF NOT EXISTS excalidraw.diagram_members (
  diagram_id BIGINT NOT NULL REFERENCES excalidraw.diagrams(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES excalidraw.users(id) ON DELETE CASCADE,
  PRIMARY KEY (diagram_id, user_id)
);

CREATE INDEX IF NOT EXISTS diagram_members_user_idx
  ON excalidraw.diagram_members (user_id);
