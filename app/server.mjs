import bcrypt from "bcryptjs";
import connectPgSimple from "connect-pg-simple";
import express from "express";
import session from "express-session";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

const PORT = Number(process.env.PORT || 3030);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "data"));
const DIST_DIR = path.join(__dirname, "dist");
const FILE_EXTENSION = ".excalidraw.json";
const DB_SCHEMA = process.env.PGSCHEMA || "excalidraw";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me-in-production";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

const pool = new Pool({
  host: process.env.PGHOST || "127.0.0.1",
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || "postgres",
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD || "postgres",
  ssl:
    String(process.env.PGSSL || "false").toLowerCase() === "true"
      ? { rejectUnauthorized: false }
      : false,
});

const PgStore = connectPgSimple(session);

const sanitizeBaseName = (value) => {
  const normalizedValue = String(value || "")
    .normalize("NFKC")
    .replace(/[^\w\- ]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_. ]+|[-_. ]+$/g, "")
    .toLowerCase();

  if (!normalizedValue) {
    return "diagrama-1";
  }

  return normalizedValue.slice(0, 80);
};

const fileNameFromName = (name) => `${sanitizeBaseName(name)}${FILE_EXTENSION}`;
const filePathFromName = (username, name) =>
  path.join(DATA_DIR, sanitizeBaseName(username), fileNameFromName(name));

const createSessionUser = (user) => ({
  id: user.id,
  username: user.username,
  displayName: user.display_name ?? user.username,
});

const ensureDataDir = async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });
};

const ensureUserDataDir = async (username) => {
  const userDir = path.join(DATA_DIR, sanitizeBaseName(username));
  await fs.mkdir(userDir, { recursive: true });
  return userDir;
};

const writeDiagramBackup = async (username, name, scene) => {
  await ensureUserDataDir(username);
  await fs.writeFile(
    filePathFromName(username, name),
    `${JSON.stringify(scene, null, 2)}\n`,
    "utf8",
  );
};

const deleteDiagramBackup = async (username, name) => {
  try {
    await fs.unlink(filePathFromName(username, name));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
};

const isValidScene = (scene) =>
  Boolean(scene && typeof scene === "object" && Array.isArray(scene.elements));

const bootstrapDatabase = async () => {
  const client = await pool.connect();

  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${DB_SCHEMA}`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${DB_SCHEMA}.users (
        id BIGSERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name TEXT,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${DB_SCHEMA}.diagrams (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES ${DB_SCHEMA}.users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        scene_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT diagrams_user_name_unique UNIQUE (user_id, name)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS diagrams_user_updated_idx
      ON ${DB_SCHEMA}.diagrams (user_id, updated_at DESC)
    `);
  } finally {
    client.release();
  }
};

const getDiagramFilePayload = (name, updatedAt) => ({
  name,
  fileName: fileNameFromName(name),
  updatedAt,
});

const requireAuth = (request, response, next) => {
  if (!request.session?.user) {
    response.status(401).json({ error: "Necesitas iniciar sesion." });
    return;
  }

  next();
};

await ensureDataDir();
await bootstrapDatabase();

app.set("trust proxy", 1);
app.use(express.json({ limit: "25mb" }));
app.use(
  session({
    name: "excalidraw.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: "auto",
      maxAge: SESSION_TTL_SECONDS * 1000,
    },
    store: new PgStore({
      pool,
      schemaName: DB_SCHEMA,
      tableName: "user_sessions",
      createTableIfMissing: true,
      ttl: SESSION_TTL_SECONDS,
    }),
  }),
);

app.get("/api/auth/session", (request, response) => {
  if (!request.session?.user) {
    response.json({ authenticated: false });
    return;
  }

  response.json({
    authenticated: true,
    user: request.session.user,
  });
});

app.post("/api/auth/login", async (request, response, next) => {
  const username = String(request.body?.username || "").trim();
  const password = String(request.body?.password || "");

  if (!username || !password) {
    response
      .status(400)
      .json({ error: "Debes indicar usuario y password." });
    return;
  }

  try {
    const result = await pool.query(
      `
        SELECT id, username, password_hash, display_name
        FROM ${DB_SCHEMA}.users
        WHERE username = $1 AND is_active = TRUE
      `,
      [username],
    );

    const user = result.rows[0];

    if (!user) {
      response.status(401).json({ error: "Credenciales no validas." });
      return;
    }

    const passwordMatches = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatches) {
      response.status(401).json({ error: "Credenciales no validas." });
      return;
    }

    request.session.regenerate((sessionError) => {
      if (sessionError) {
        next(sessionError);
        return;
      }

      request.session.user = createSessionUser(user);
      request.session.save((saveError) => {
        if (saveError) {
          next(saveError);
          return;
        }

        response.json({
          ok: true,
          user: request.session.user,
        });
      });
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/logout", (request, response, next) => {
  if (!request.session) {
    response.json({ ok: true });
    return;
  }

  request.session.destroy((error) => {
    if (error) {
      next(error);
      return;
    }

    response.clearCookie("excalidraw.sid");
    response.json({ ok: true });
  });
});

app.get("/api/files", requireAuth, async (request, response, next) => {
  try {
    const result = await pool.query(
      `
        SELECT name, updated_at
        FROM ${DB_SCHEMA}.diagrams
        WHERE user_id = $1
        ORDER BY updated_at DESC
      `,
      [request.session.user.id],
    );

    response.json({
      files: result.rows.map((row) =>
        getDiagramFilePayload(row.name, row.updated_at.toISOString()),
      ),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/files/:name", requireAuth, async (request, response, next) => {
  try {
    const name = sanitizeBaseName(request.params.name);
    const result = await pool.query(
      `
        SELECT name, scene_json, updated_at
        FROM ${DB_SCHEMA}.diagrams
        WHERE user_id = $1 AND name = $2
      `,
      [request.session.user.id, name],
    );

    const diagram = result.rows[0];

    if (!diagram) {
      response.status(404).json({ error: "El diagrama solicitado no existe." });
      return;
    }

    response.json({
      file: getDiagramFilePayload(diagram.name, diagram.updated_at.toISOString()),
      scene: diagram.scene_json,
    });
  } catch (error) {
    next(error);
  }
});

app.put("/api/files/:name", requireAuth, async (request, response, next) => {
  try {
    const name = sanitizeBaseName(request.params.name);
    const scene = request.body;

    if (!isValidScene(scene)) {
      response.status(400).json({ error: "El contenido del diagrama no es valido." });
      return;
    }

    const result = await pool.query(
      `
        INSERT INTO ${DB_SCHEMA}.diagrams (user_id, name, scene_json)
        VALUES ($1, $2, $3::jsonb)
        ON CONFLICT (user_id, name)
        DO UPDATE SET scene_json = EXCLUDED.scene_json, updated_at = NOW()
        RETURNING name, updated_at
      `,
      [request.session.user.id, name, JSON.stringify(scene)],
    );

    await writeDiagramBackup(request.session.user.username, name, scene);

    response.json({
      ok: true,
      file: getDiagramFilePayload(
        result.rows[0].name,
        result.rows[0].updated_at.toISOString(),
      ),
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/files/:name", requireAuth, async (request, response, next) => {
  try {
    const name = sanitizeBaseName(request.params.name);
    const result = await pool.query(
      `
        DELETE FROM ${DB_SCHEMA}.diagrams
        WHERE user_id = $1 AND name = $2
        RETURNING name
      `,
      [request.session.user.id, name],
    );

    if (result.rowCount === 0) {
      response.status(404).json({ error: "El diagrama solicitado no existe." });
      return;
    }

    await deleteDiagramBackup(request.session.user.username, name);

    response.json({
      ok: true,
      file: {
        name,
        fileName: fileNameFromName(name),
      },
    });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(DIST_DIR));

app.get(/.*/, async (_request, response, next) => {
  try {
    response.sendFile(path.join(DIST_DIR, "index.html"));
  } catch (error) {
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({
    error: "Se produjo un error interno en el servidor.",
  });
});

app.listen(PORT, () => {
  console.log(`Excalidraw auth server listening on port ${PORT}`);
  console.log(`PostgreSQL schema: ${DB_SCHEMA}`);
  console.log(`Data directory: ${DATA_DIR}`);
});
