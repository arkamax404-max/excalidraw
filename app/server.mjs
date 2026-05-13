import express from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

const PORT = Number(process.env.PORT || 3030);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "data"));
const DIST_DIR = path.join(__dirname, "dist");
const FILE_EXTENSION = ".excalidraw.json";

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
const displayNameFromFile = (fileName) => fileName.replace(new RegExp(`${FILE_EXTENSION}$`), "");
const filePathFromName = (name) => path.join(DATA_DIR, fileNameFromName(name));

const ensureDataDir = async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });
};

const readDirectoryEntries = async () => {
  await ensureDataDir();
  const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });

  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(FILE_EXTENSION))
      .map(async (entry) => {
        const fullPath = path.join(DATA_DIR, entry.name);
        const stats = await fs.stat(fullPath);
        return {
          name: displayNameFromFile(entry.name),
          fileName: entry.name,
          updatedAt: stats.mtime.toISOString(),
          size: stats.size,
        };
      }),
  );

  return files.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
};

app.use(express.json({ limit: "25mb" }));

app.get("/api/files", async (_request, response, next) => {
  try {
    const files = await readDirectoryEntries();
    response.json({ files });
  } catch (error) {
    next(error);
  }
});

app.get("/api/files/:name", async (request, response, next) => {
  try {
    const name = sanitizeBaseName(request.params.name);
    const filePath = filePathFromName(name);
    const content = await fs.readFile(filePath, "utf8");
    response.json({
      file: {
        name,
        fileName: fileNameFromName(name),
      },
      scene: JSON.parse(content),
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      response.status(404).json({ error: "El diagrama solicitado no existe." });
      return;
    }

    next(error);
  }
});

app.put("/api/files/:name", async (request, response, next) => {
  try {
    const name = sanitizeBaseName(request.params.name);
    const filePath = filePathFromName(name);
    const scene = request.body;

    if (!scene || typeof scene !== "object" || !Array.isArray(scene.elements)) {
      response.status(400).json({ error: "El contenido del diagrama no es valido." });
      return;
    }

    await ensureDataDir();
    await fs.writeFile(filePath, `${JSON.stringify(scene, null, 2)}\n`, "utf8");

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

app.delete("/api/files/:name", async (request, response, next) => {
  try {
    const name = sanitizeBaseName(request.params.name);
    const filePath = filePathFromName(name);

    await fs.unlink(filePath);

    response.json({
      ok: true,
      file: {
        name,
        fileName: fileNameFromName(name),
      },
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      response.status(404).json({ error: "El diagrama solicitado no existe." });
      return;
    }

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

await ensureDataDir();

app.listen(PORT, () => {
  console.log(`Excalidraw local storage listening on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});
