-- Apply after 001_init.sql; substitute the schema for custom installations.
ALTER TABLE excalidraw.diagrams
  ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'excalidraw.diagrams'::regclass
    AND conname = 'diagrams_revision_positive') THEN
    ALTER TABLE excalidraw.diagrams ADD CONSTRAINT diagrams_revision_positive
      CHECK (revision > 0);
  END IF;
END $$;
