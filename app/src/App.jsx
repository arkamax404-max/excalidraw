import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Excalidraw,
  MainMenu,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import "./App.css";

const DEFAULT_FILE_NAME = "diagrama-1";

const createStatus = (kind = "info", message = "Listo.") => ({
  kind,
  message,
});

async function parseApiResponse(response) {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return response.json();
  }

  return null;
}

function App() {
  const [excalidrawAPI, setExcalidrawAPI] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authUser, setAuthUser] = useState(null);
  const [authForm, setAuthForm] = useState({
    username: "",
    password: "",
  });
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [fileName, setFileName] = useState(DEFAULT_FILE_NAME);
  const [availableFiles, setAvailableFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [status, setStatus] = useState(createStatus());

  const currentFileName = useMemo(() => {
    const trimmedValue = fileName.trim();
    return trimmedValue || DEFAULT_FILE_NAME;
  }, [fileName]);

  const handleUnauthorized = useCallback((message = "Tu sesion ha expirado.") => {
    setAuthUser(null);
    setAvailableFiles([]);
    setFileName(DEFAULT_FILE_NAME);
    setPanelOpen(true);
    setStatus(createStatus("error", message));
  }, []);

  const apiRequest = useCallback(
    async (url, options = {}) => {
      const headers = { ...(options.headers || {}) };
      if (options.body && !headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
      }

      const response = await fetch(url, {
        credentials: "include",
        ...options,
        headers,
      });
      const payload = await parseApiResponse(response);

      if (response.status === 401) {
        handleUnauthorized(payload?.error || "Tu sesion ha expirado.");
        const error = new Error(payload?.error || "Tu sesion ha expirado.");
        error.status = 401;
        throw error;
      }

      if (!response.ok) {
        const error = new Error(payload?.error || "Se produjo un error inesperado.");
        error.status = response.status;
        throw error;
      }

      return payload;
    },
    [handleUnauthorized],
  );

  const refreshFiles = useCallback(async () => {
    if (!authUser) {
      setAvailableFiles([]);
      return;
    }

    try {
      const payload = await apiRequest("/api/files");
      setAvailableFiles(payload?.files ?? []);
    } catch (error) {
      if (error.status !== 401) {
        setStatus(createStatus("error", error.message));
      }
    }
  }, [apiRequest, authUser]);

  useEffect(() => {
    const checkSession = async () => {
      try {
        const response = await fetch("/api/auth/session", {
          credentials: "include",
        });
        const payload = await parseApiResponse(response);

        if (payload?.authenticated) {
          setAuthUser(payload.user);
          setStatus(createStatus("success", `Sesion activa para ${payload.user.username}.`));
        }
      } catch (_error) {
        setAuthError("No se pudo comprobar la sesion actual.");
      } finally {
        setAuthChecked(true);
      }
    };

    void checkSession();
  }, []);

  useEffect(() => {
    if (authUser) {
      void refreshFiles();
    }
  }, [authUser, refreshFiles]);

  const login = useCallback(
    async (event) => {
      event.preventDefault();
      setAuthBusy(true);
      setAuthError("");

      try {
        const payload = await apiRequest("/api/auth/login", {
          method: "POST",
          body: JSON.stringify(authForm),
        });

        setAuthUser(payload.user);
        setAuthForm({ username: "", password: "" });
        setStatus(createStatus("success", `Sesion iniciada como ${payload.user.username}.`));
      } catch (error) {
        setAuthError(error.message);
      } finally {
        setAuthBusy(false);
      }
    },
    [apiRequest, authForm],
  );

  const logout = useCallback(async () => {
    setBusy(true);

    try {
      await apiRequest("/api/auth/logout", { method: "POST" });
      setAuthUser(null);
      setAvailableFiles([]);
      setFileName(DEFAULT_FILE_NAME);
      setPanelOpen(true);
      setStatus(createStatus("info", "Sesion cerrada."));
    } catch (error) {
      setStatus(createStatus("error", error.message));
    } finally {
      setBusy(false);
    }
  }, [apiRequest]);

  const saveDiagram = useCallback(async () => {
    if (!excalidrawAPI) {
      return;
    }

    setBusy(true);
    setStatus(createStatus("info", "Guardando diagrama..."));

    try {
      const scene = serializeAsJSON(
        excalidrawAPI.getSceneElementsIncludingDeleted(),
        excalidrawAPI.getAppState(),
        excalidrawAPI.getFiles(),
        "database",
      );

      const payload = await apiRequest(
        `/api/files/${encodeURIComponent(currentFileName)}`,
        {
          method: "PUT",
          body: scene,
        },
      );

      setFileName(payload.file.name);
      setStatus(
        createStatus("success", `Guardado como ${payload.file.fileName}.`),
      );
      await refreshFiles();
    } catch (error) {
      setStatus(createStatus("error", error.message));
    } finally {
      setBusy(false);
    }
  }, [apiRequest, currentFileName, excalidrawAPI, refreshFiles]);

  const loadDiagram = useCallback(
    async (name) => {
      if (!excalidrawAPI) {
        return;
      }

      setBusy(true);
      setStatus(createStatus("info", `Cargando ${name}...`));

      try {
        const payload = await apiRequest(`/api/files/${encodeURIComponent(name)}`);
        const scene = payload.scene ?? {};
        const files = Object.values(scene.files ?? {});

        excalidrawAPI.resetScene();
        if (files.length > 0) {
          excalidrawAPI.addFiles(files);
        }
        excalidrawAPI.updateScene({
          elements: scene.elements ?? [],
          appState: scene.appState ?? {},
        });
        excalidrawAPI.history.clear();
        setFileName(payload.file.name);
        setStatus(
          createStatus("success", `${payload.file.fileName} cargado.`),
        );
      } catch (error) {
        setStatus(createStatus("error", error.message));
      } finally {
        setBusy(false);
      }
    },
    [apiRequest, excalidrawAPI],
  );

  const deleteDiagram = useCallback(
    async (name) => {
      setBusy(true);
      setStatus(createStatus("info", `Eliminando ${name}...`));

      try {
        const payload = await apiRequest(`/api/files/${encodeURIComponent(name)}`, {
          method: "DELETE",
        });

        if (currentFileName === name) {
          setFileName(DEFAULT_FILE_NAME);
        }

        setStatus(
          createStatus("success", `${payload.file.fileName} eliminado.`),
        );
        await refreshFiles();
      } catch (error) {
        setStatus(createStatus("error", error.message));
      } finally {
        setBusy(false);
      }
    },
    [apiRequest, currentFileName, refreshFiles],
  );

  const createBlankDiagram = useCallback(() => {
    if (!excalidrawAPI) {
      return;
    }

    excalidrawAPI.resetScene();
    excalidrawAPI.history.clear();
    setFileName(DEFAULT_FILE_NAME);
    setStatus(createStatus("info", "Lienzo reiniciado."));
  }, [excalidrawAPI]);

  const renderTopRightUI = useCallback(
    () => (
      <button
        type="button"
        className={`sidebar-trigger default-sidebar-trigger${panelOpen ? " active" : ""}`}
        onClick={() => setPanelOpen((currentValue) => !currentValue)}
        title="Mostrar u ocultar panel de guardado en servidor"
        aria-label="Mostrar u ocultar panel de guardado en servidor"
      >
        <svg className="topbar-storage-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 2v14h12V7.5L15.5 5H15v4H7V5Zm4 0v2h4V5Zm-2 8h8v4H7v-4Z" />
        </svg>
        <span className="sidebar-trigger__label">Servidor</span>
      </button>
    ),
    [panelOpen],
  );

  if (!authChecked) {
    return (
      <div className="login-shell">
        <div className="login-card login-card-loading">
          <h1>Excalidraw</h1>
          <p>Comprobando sesion...</p>
        </div>
      </div>
    );
  }

  if (!authUser) {
    return (
      <div className="login-shell">
        <form className="login-card" onSubmit={login}>
          <div className="login-copy">
            <h1>Excalidraw</h1>
            <p>Accede con tu usuario y password para trabajar sobre tus diagramas.</p>
          </div>

          <label className="login-field">
            <span>Usuario</span>
            <input
              value={authForm.username}
              onChange={(event) =>
                setAuthForm((currentValue) => ({
                  ...currentValue,
                  username: event.target.value,
                }))
              }
              autoComplete="username"
              required
            />
          </label>

          <label className="login-field">
            <span>Password</span>
            <input
              type="password"
              value={authForm.password}
              onChange={(event) =>
                setAuthForm((currentValue) => ({
                  ...currentValue,
                  password: event.target.value,
                }))
              }
              autoComplete="current-password"
              required
            />
          </label>

          {authError ? <p className="login-error">{authError}</p> : null}

          <button className="login-submit" type="submit" disabled={authBusy}>
            {authBusy ? "Entrando..." : "Entrar"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <main className="editor-shell">
        <Excalidraw
          excalidrawAPI={setExcalidrawAPI}
          name={currentFileName}
          renderTopRightUI={renderTopRightUI}
          UIOptions={{
            canvasActions: {
              loadScene: false,
              saveAsImage: true,
            },
          }}
        >
          <MainMenu />
        </Excalidraw>

        {panelOpen ? (
          <section className="storage-panel">
            <div className="storage-panel-header">
              <span className="storage-user-badge">{authUser.username}</span>
              <div className="storage-panel-header-actions">
                <button
                  type="button"
                  className="storage-logout"
                  onClick={() => void logout()}
                  disabled={busy}
                >
                  Logout
                </button>
                <button
                  type="button"
                  className="panel-toggle"
                  onClick={() => setPanelOpen(false)}
                  aria-label="Ocultar panel"
                  title="Ocultar panel"
                >
                  ×
                </button>
              </div>
            </div>

            <div className="storage-panel-body">
              <div className="storage-primary-row">
                <input
                  id="fileName"
                  value={fileName}
                  onChange={(event) => setFileName(event.target.value)}
                  placeholder={DEFAULT_FILE_NAME}
                  aria-label="Nombre del diagrama"
                />
                <button type="button" onClick={() => void saveDiagram()} disabled={busy}>
                  Guardar
                </button>
              </div>

              <div className="storage-secondary-row">
                <button type="button" onClick={createBlankDiagram} disabled={busy}>
                  Nuevo
                </button>
                <button type="button" onClick={() => void refreshFiles()} disabled={busy}>
                  Recargar
                </button>
              </div>

              <div className="section-heading">
                <h2>Mis diagramas</h2>
                <span className="storage-panel-count">{availableFiles.length}</span>
              </div>

              {availableFiles.length === 0 ? (
                <p className="empty-state">Todavia no tienes diagramas guardados.</p>
              ) : (
                <ul className="file-list">
                  {availableFiles.map((item) => (
                    <li key={item.fileName} className="file-row">
                      <button
                        type="button"
                        className="file-button"
                        onClick={() => void loadDiagram(item.name)}
                        disabled={busy}
                      >
                        <span className="file-name">{item.fileName}</span>
                        <small>{new Date(item.updatedAt).toLocaleString("es-ES")}</small>
                      </button>
                      <button
                        type="button"
                        className="file-delete-button"
                        onClick={() => void deleteDiagram(item.name)}
                        disabled={busy}
                        aria-label={`Eliminar ${item.fileName}`}
                        title={`Eliminar ${item.fileName}`}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm1 6h2v8h-2V9Zm4 0h2v8h-2V9ZM7 9h2v8H7V9Zm-1 11a2 2 0 0 1-2-2V8h16v10a2 2 0 0 1-2 2H6Z" />
                        </svg>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <p className={`status status-${status.kind}`}>{status.message}</p>
          </section>
        ) : null}
      </main>
    </div>
  );
}

export default App;
