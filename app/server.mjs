import bcrypt from "bcryptjs";
import connectPgSimple from "connect-pg-simple";
import express from "express";
import session from "express-session";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  OpenRouterError,
  createGenerationRateLimiter,
  generateMermaidWithFallback,
} from "./openrouter.mjs";

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
const checkGenerationRateLimit = createGenerationRateLimiter();

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

const sanitizeUsername = (value) => String(value || "").trim();
const isAdminUser = (user) => user?.username === "admin";

const createSessionUser = (user) => ({
  id: user.id,
  username: user.username,
  displayName: user.display_name ?? user.username,
  isAdmin: isAdminUser(user),
});

const ensureDataDir = async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });
};

const ensureUserDataDir = async (username) => {
  const userDir = path.join(DATA_DIR, sanitizeBaseName(username));
  await fs.mkdir(userDir, { recursive: true });
  return userDir;
};

const deleteUserDataDir = async (username) => {
  await fs.rm(path.join(DATA_DIR, sanitizeBaseName(username)), {
    recursive: true,
    force: true,
  });
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
        last_login_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      ALTER TABLE ${DB_SCHEMA}.users
      ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ
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
      ALTER TABLE ${DB_SCHEMA}.diagrams
      ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid = '${DB_SCHEMA}.diagrams'::regclass
          AND conname = 'diagrams_revision_positive') THEN
          ALTER TABLE ${DB_SCHEMA}.diagrams ADD CONSTRAINT diagrams_revision_positive
            CHECK (revision > 0);
        END IF;
      END $$
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${DB_SCHEMA}.diagram_members (
        diagram_id BIGINT NOT NULL REFERENCES ${DB_SCHEMA}.diagrams(id) ON DELETE CASCADE,
        user_id BIGINT NOT NULL REFERENCES ${DB_SCHEMA}.users(id) ON DELETE CASCADE,
        PRIMARY KEY (diagram_id, user_id)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS diagram_members_user_idx
      ON ${DB_SCHEMA}.diagram_members (user_id)
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

const requireAdmin = (request, response, next) => {
  if (!request.session?.user) {
    response.status(401).json({ error: "Necesitas iniciar sesion." });
    return;
  }

  if (!request.session.user.isAdmin) {
    response.status(403).json({ error: "Necesitas permisos de administrador." });
    return;
  }

  next();
};

const getUserListItem = (user) => ({
  id: user.id,
  username: user.username,
  displayName: user.display_name ?? user.username,
  isActive: user.is_active,
  lastLoginAt: user.last_login_at ? user.last_login_at.toISOString() : null,
  createdAt: user.created_at.toISOString(),
  updatedAt: user.updated_at.toISOString(),
  diagramCount: Number(user.diagram_count ?? 0),
});

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

    const loginUpdateResult = await pool.query(
      `
        UPDATE ${DB_SCHEMA}.users
        SET last_login_at = NOW()
        WHERE id = $1
        RETURNING id, username, display_name, last_login_at
      `,
      [user.id],
    );
    const sessionUser = createSessionUser(loginUpdateResult.rows[0] ?? user);

    request.session.regenerate((sessionError) => {
      if (sessionError) {
        next(sessionError);
        return;
      }

      request.session.user = sessionUser;
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

app.get("/api/admin/users", requireAdmin, async (_request, response, next) => {
  try {
    const result = await pool.query(`
      SELECT
        users.id,
        users.username,
        users.display_name,
        users.is_active,
        users.last_login_at,
        users.created_at,
        users.updated_at,
        COUNT(diagrams.id) AS diagram_count
      FROM ${DB_SCHEMA}.users AS users
      LEFT JOIN ${DB_SCHEMA}.diagrams AS diagrams
        ON diagrams.user_id = users.id
      GROUP BY users.id
      ORDER BY users.username ASC
    `);

    response.json({
      users: result.rows.map(getUserListItem),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/users", requireAdmin, async (request, response, next) => {
  const username = sanitizeUsername(request.body?.username);
  const password = String(request.body?.password || "");
  const displayName = String(request.body?.displayName || "").trim() || null;
  const isActive = request.body?.isActive !== false;

  if (!/^[A-Za-z0-9._-]{3,50}$/.test(username)) {
    response.status(400).json({
      error:
        "El usuario debe tener entre 3 y 50 caracteres y solo usar letras, numeros, punto, guion y guion bajo.",
    });
    return;
  }

  if (password.length < 8) {
    response.status(400).json({
      error: "La password debe tener al menos 8 caracteres.",
    });
    return;
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `
        INSERT INTO ${DB_SCHEMA}.users (username, password_hash, display_name, is_active)
        VALUES ($1, $2, $3, $4)
        RETURNING id, username, display_name, is_active, last_login_at, created_at, updated_at
      `,
      [username, passwordHash, displayName, isActive],
    );

    response.status(201).json({
      ok: true,
      user: {
        ...getUserListItem({ ...result.rows[0], diagram_count: 0 }),
      },
    });
  } catch (error) {
    if (error.code === "23505") {
      response.status(409).json({ error: "Ese usuario ya existe." });
      return;
    }

    next(error);
  }
});

app.put("/api/admin/users/:id", requireAdmin, async (request, response, next) => {
  const userId = Number(request.params.id);
  const displayName = String(request.body?.displayName || "").trim() || null;
  const password = String(request.body?.password || "");
  const isActive = Boolean(request.body?.isActive);

  if (!Number.isInteger(userId) || userId <= 0) {
    response.status(400).json({ error: "El identificador de usuario no es valido." });
    return;
  }

  if (request.session.user.id === userId && !isActive) {
    response.status(400).json({ error: "No puedes desactivar tu propio usuario." });
    return;
  }

  if (password && password.length < 8) {
    response.status(400).json({
      error: "La password debe tener al menos 8 caracteres.",
    });
    return;
  }

  try {
    const existingUserResult = await pool.query(
      `
        SELECT id
        FROM ${DB_SCHEMA}.users
        WHERE id = $1
      `,
      [userId],
    );

    if (existingUserResult.rowCount === 0) {
      response.status(404).json({ error: "El usuario solicitado no existe." });
      return;
    }

    const passwordHash = password ? await bcrypt.hash(password, 12) : null;
    const result = await pool.query(
      `
        UPDATE ${DB_SCHEMA}.users
        SET
          display_name = $2,
          is_active = $3,
          password_hash = COALESCE($4, password_hash),
          updated_at = NOW()
        WHERE id = $1
        RETURNING id, username, display_name, is_active, last_login_at, created_at, updated_at
      `,
      [userId, displayName, isActive, passwordHash],
    );

    response.json({
      ok: true,
      user: {
        ...getUserListItem({ ...result.rows[0], diagram_count: 0 }),
      },
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/admin/users/:id", requireAdmin, async (request, response, next) => {
  const userId = Number(request.params.id);

  if (!Number.isInteger(userId) || userId <= 0) {
    response.status(400).json({ error: "El identificador de usuario no es valido." });
    return;
  }

  if (request.session.user.id === userId) {
    response.status(400).json({ error: "No puedes eliminar tu propio usuario." });
    return;
  }

  try {
    const result = await pool.query(
      `
        DELETE FROM ${DB_SCHEMA}.users
        WHERE id = $1
        RETURNING id, username
      `,
      [userId],
    );

    if (result.rowCount === 0) {
      response.status(404).json({ error: "El usuario solicitado no existe." });
      return;
    }

    await deleteUserDataDir(result.rows[0].username);

    response.json({
      ok: true,
      user: {
        id: result.rows[0].id,
        username: result.rows[0].username,
      },
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

app.post("/api/ai/diagram", requireAuth, async (request, response) => {
  const retryAfter = checkGenerationRateLimit(String(request.session.user.id));
  if (retryAfter > 0) {
    response.set("Retry-After", String(retryAfter));
    response.status(429).json({
      error: "Too many AI generation requests. Try again shortly.",
    });
    return;
  }

  try {
    const result = await generateMermaidWithFallback({
      prompt: request.body?.prompt,
      openRouterApiKey: process.env.OPENROUTER_API_KEY,
      groqApiKey: process.env.GROQ_API_KEY,
      groqModel: process.env.GROQ_MODEL,
      groqModels: process.env.GROQ_MODELS,
    });
    response.json(result);
  } catch (error) {
    if (error instanceof OpenRouterError) {
      response.status(error.status).json({ error: error.message });
      return;
    }

    response.status(502).json({ error: "AI generation failed unexpectedly." });
  }
});

// IDs remain decimal strings: PostgreSQL BIGINT can exceed Number.MAX_SAFE_INTEGER.
const getDiagramPayload = (row) => ({
  id: row.id,
  revision: row.revision,
  ...getDiagramFilePayload(row.name, row.updated_at.toISOString()),
});

const diagramETag = (row) => `"${row.id}:${row.revision}"`;

const isValidDiagramId = (id) =>
  /^[1-9][0-9]{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n;
const memberAccess = `EXISTS (
  SELECT 1 FROM ${DB_SCHEMA}.diagram_members AS membership
  JOIN ${DB_SCHEMA}.users AS member ON member.id = membership.user_id AND member.is_active
  WHERE membership.diagram_id = diagrams.id AND membership.user_id = $1
)`;

app.get("/api/diagrams", requireAuth, async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT id, name, revision, updated_at
       FROM ${DB_SCHEMA}.diagrams
       WHERE user_id = $1 OR ${memberAccess}
       ORDER BY updated_at DESC, id DESC`,
      [request.session.user.id],
    );
    response.json({ diagrams: result.rows.map(getDiagramPayload) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/diagrams/:id", requireAuth, async (request, response, next) => {
  const id = request.params.id;
  if (!isValidDiagramId(id)) {
    response.status(400).json({ error: "El identificador de diagrama no es valido." });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT id, name, revision, scene_json, updated_at
       FROM ${DB_SCHEMA}.diagrams
       WHERE id = $2 AND (user_id = $1 OR ${memberAccess})`,
      [request.session.user.id, id],
    );
    const diagram = result.rows[0];
    if (!diagram) {
      response.status(404).json({ error: "El diagrama solicitado no existe." });
      return;
    }
    response.set("ETag", diagramETag(diagram));
    response.json({ diagram: getDiagramPayload(diagram), scene: diagram.scene_json });
  } catch (error) {
    next(error);
  }
});

const requireDiagramOwner = async (request, response, next) => {
  if (!isValidDiagramId(request.params.id)) {
    response.status(400).json({ error: "El identificador de diagrama no es valido." });
    return;
  }
  try {
    const result = await pool.query(
      `SELECT user_id FROM ${DB_SCHEMA}.diagrams WHERE id = $1`, [request.params.id],
    );
    if (!result.rows[0]) {
      response.status(404).json({ error: "El diagrama solicitado no existe." });
    } else if (result.rows[0].user_id !== request.session.user.id) {
      response.status(403).json({ error: "Necesitas ser propietario del diagrama." });
    } else {
      next();
    }
  } catch (error) { next(error); }
};

app.get("/api/diagrams/:id/members", requireAuth, requireDiagramOwner, async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT users.id, users.username, users.display_name
       FROM ${DB_SCHEMA}.diagram_members AS membership
       JOIN ${DB_SCHEMA}.users AS users ON users.id = membership.user_id
       WHERE membership.diagram_id = $1 ORDER BY users.username ASC`, [request.params.id],
    );
    response.json({ members: result.rows.map(createSessionUser) });
  } catch (error) { next(error); }
});

const changeMembership = async (request, response, next) => {
  const raw = request.method === "POST" ? request.body?.username : request.params.username;
  const username = sanitizeUsername(raw);
  if (typeof raw !== "string" || !/^[A-Za-z0-9._-]{3,50}$/.test(username)) {
    response.status(400).json({ error: "El usuario no es valido." });
    return;
  }
  try {
    const result = await pool.query(
      `SELECT id, username, display_name, is_active FROM ${DB_SCHEMA}.users WHERE username = $1`, [username],
    );
    const user = result.rows[0];
    if (user?.id === request.session.user.id) {
      response.status(400).json({ error: "El propietario no puede ser miembro." });
      return;
    }
    if (request.method === "POST") {
      if (!user?.is_active) {
        response.status(404).json({ error: "El usuario activo solicitado no existe." });
        return;
      }
      const added = await pool.query(
        `INSERT INTO ${DB_SCHEMA}.diagram_members (diagram_id, user_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING user_id`, [request.params.id, user.id],
      );
      if (!added.rowCount) {
        response.status(409).json({ error: "Ese usuario ya es miembro." });
        return;
      }
      response.status(201).json({ ok: true, member: createSessionUser(user) });
    } else {
      const removed = await pool.query(
        `DELETE FROM ${DB_SCHEMA}.diagram_members WHERE diagram_id = $1 AND user_id = $2`,
        [request.params.id, user?.id ?? null],
      );
      if (!removed.rowCount) {
        response.status(404).json({ error: "La membresia solicitada no existe." });
        return;
      }
      response.json({ ok: true });
    }
  } catch (error) { next(error); }
};
app.post("/api/diagrams/:id/members", requireAuth, requireDiagramOwner, changeMembership);
app.delete("/api/diagrams/:id/members/:username", requireAuth, requireDiagramOwner, changeMembership);

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
        SELECT id, name, revision, scene_json, updated_at
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

    response.set("ETag", diagramETag(diagram));
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
        DO UPDATE SET scene_json = EXCLUDED.scene_json, updated_at = NOW(),
          revision = diagrams.revision + 1
        WHERE diagrams.revision < 9223372036854775807
        RETURNING id, name, revision, updated_at
      `,
      [request.session.user.id, name, JSON.stringify(scene)],
    );

    if (result.rowCount === 0) {
      response.status(409).json({ error: "El diagrama ha alcanzado el limite de revisiones." });
      return;
    }

    await writeDiagramBackup(request.session.user.username, name, scene);

    response.set("ETag", diagramETag(result.rows[0]));
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
