import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Excalidraw,
  MainMenu,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import "./App.css";
import { excalidrawToMermaid } from "./mermaid/excalidrawToMermaid.js";
import { toMermaidDownloadFilename } from "./mermaid/mermaidFilename.js";
import { convertAndInsertMermaid } from "./ai/mermaidToScene.js";

const DEFAULT_FILE_NAME = "diagrama-1";
const ADMIN_FORM_INITIAL_STATE = {
  id: null,
  username: "",
  displayName: "",
  password: "",
  isActive: true,
};

const createStatus = (kind = "info", message = "Listo.") => ({
  kind,
  message,
});

const formatTimestamp = (value) =>
  value ? new Date(value).toLocaleString("es-ES") : "Nunca";

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
  const [adminPanelOpen, setAdminPanelOpen] = useState(false);
  const [adminUsers, setAdminUsers] = useState([]);
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminStatus, setAdminStatus] = useState(createStatus());
  const [adminForm, setAdminForm] = useState(ADMIN_FORM_INITIAL_STATE);
  const [aiDialogOpen, setAiDialogOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState("");
  const aiAbortController = useRef(null);

  const currentFileName = useMemo(() => {
    const trimmedValue = fileName.trim();
    return trimmedValue || DEFAULT_FILE_NAME;
  }, [fileName]);

  const isAdmin = authUser?.isAdmin === true;

  const handleUnauthorized = useCallback((message = "Tu sesion ha expirado.") => {
    setAuthUser(null);
    setAvailableFiles([]);
    setFileName(DEFAULT_FILE_NAME);
    setPanelOpen(true);
    setAdminPanelOpen(false);
    setAdminUsers([]);
    setAdminForm(ADMIN_FORM_INITIAL_STATE);
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

  const refreshAdminUsers = useCallback(async () => {
    if (!authUser?.isAdmin) {
      setAdminUsers([]);
      return;
    }

    setAdminBusy(true);

    try {
      const payload = await apiRequest("/api/admin/users");
      setAdminUsers(payload?.users ?? []);
    } catch (error) {
      if (error.status !== 401) {
        setAdminStatus(createStatus("error", error.message));
      }
    } finally {
      setAdminBusy(false);
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

  useEffect(() => {
    if (adminPanelOpen && authUser?.isAdmin) {
      void refreshAdminUsers();
    }
  }, [adminPanelOpen, authUser, refreshAdminUsers]);

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
        setAdminUsers([]);
        setAdminForm(ADMIN_FORM_INITIAL_STATE);
        setAdminPanelOpen(false);
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
      setAdminPanelOpen(false);
      setAdminUsers([]);
      setAdminForm(ADMIN_FORM_INITIAL_STATE);
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

  const closeAiDialog = useCallback(() => {
    aiAbortController.current?.abort();
    aiAbortController.current = null;
    setAiBusy(false);
    setAiDialogOpen(false);
    setAiError("");
  }, []);

  const generateDiagram = useCallback(
    async (event) => {
      event.preventDefault();
      if (!excalidrawAPI || aiBusy) {
        return;
      }

      const controller = new AbortController();
      aiAbortController.current = controller;
      setAiBusy(true);
      setAiError("");

      try {
        const payload = await apiRequest("/api/ai/diagram", {
          method: "POST",
          body: JSON.stringify({ prompt: aiPrompt }),
          signal: controller.signal,
        });
        const insertedElements = await convertAndInsertMermaid({
          mermaid: payload.mermaid,
          excalidrawAPI,
        });

        setAiPrompt("");
        setAiDialogOpen(false);
        excalidrawAPI.setToast({
          message:
            payload.provider === "groq"
              ? `Generated diagram inserted (${insertedElements.length} elements) using the fallback provider.`
              : `Generated diagram inserted (${insertedElements.length} elements).`,
          duration: 4000,
        });
      } catch (error) {
        if (error.name !== "AbortError") {
          setAiError(
            error.status
              ? error.message
              : "The generated Mermaid could not be converted. Refine the prompt and try again.",
          );
        }
      } finally {
        if (aiAbortController.current === controller) {
          aiAbortController.current = null;
          setAiBusy(false);
        }
      }
    },
    [aiBusy, aiPrompt, apiRequest, excalidrawAPI],
  );

  const resetAdminForm = useCallback(() => {
    setAdminForm(ADMIN_FORM_INITIAL_STATE);
  }, []);

  const submitAdminUser = useCallback(
    async (event) => {
      event.preventDefault();

      if (!isAdmin) {
        return;
      }

      const creatingUser = adminForm.id === null;
      setAdminBusy(true);
      setAdminStatus(
        createStatus("info", creatingUser ? "Creando usuario..." : "Actualizando usuario..."),
      );

      try {
        const payload = {
          displayName: adminForm.displayName,
          isActive: adminForm.isActive,
        };

        if (creatingUser) {
          payload.username = adminForm.username;
          payload.password = adminForm.password;
        } else if (adminForm.password) {
          payload.password = adminForm.password;
        }

        await apiRequest(
          creatingUser
            ? "/api/admin/users"
            : `/api/admin/users/${encodeURIComponent(adminForm.id)}`,
          {
            method: creatingUser ? "POST" : "PUT",
            body: JSON.stringify(payload),
          },
        );

        resetAdminForm();
        await refreshAdminUsers();
        setAdminStatus(
          createStatus(
            "success",
            creatingUser ? "Usuario creado correctamente." : "Usuario actualizado correctamente.",
          ),
        );
      } catch (error) {
        setAdminStatus(createStatus("error", error.message));
      } finally {
        setAdminBusy(false);
      }
    },
    [adminForm, apiRequest, isAdmin, refreshAdminUsers, resetAdminForm],
  );

  const editAdminUser = useCallback((user) => {
    setAdminForm({
      id: user.id,
      username: user.username,
      displayName: user.displayName === user.username ? "" : user.displayName,
      password: "",
      isActive: user.isActive,
    });
    setAdminPanelOpen(true);
    setAdminStatus(createStatus("info", `Editando ${user.username}.`));
  }, []);

  const deleteAdminUser = useCallback(
    async (user) => {
      if (!window.confirm(`Se eliminara el usuario ${user.username} y todos sus diagramas. Continuar?`)) {
        return;
      }

      setAdminBusy(true);
      setAdminStatus(createStatus("info", `Eliminando ${user.username}...`));

      try {
        await apiRequest(`/api/admin/users/${encodeURIComponent(user.id)}`, {
          method: "DELETE",
        });
        if (adminForm.id === user.id) {
          resetAdminForm();
        }
        await refreshAdminUsers();
        setAdminStatus(createStatus("success", `${user.username} eliminado.`));
      } catch (error) {
        setAdminStatus(createStatus("error", error.message));
      } finally {
        setAdminBusy(false);
      }
    },
    [adminForm.id, apiRequest, refreshAdminUsers, resetAdminForm],
  );

  const renderTopRightUI = useCallback(
    () => (
        <button
          type="button"
          className={`sidebar-trigger default-sidebar-trigger${panelOpen ? " active" : ""}`}
          onClick={() => setPanelOpen((currentValue) => !currentValue)}
          title="Mostrar u ocultar panel"
          aria-label="Mostrar u ocultar panel"
        >
        <svg className="topbar-storage-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 2v14h12V7.5L15.5 5H15v4H7V5Zm4 0v2h4V5Zm-2 8h8v4H7v-4Z" />
        </svg>
        <span className="sidebar-trigger__label">Servidor</span>
      </button>
    ),
    [panelOpen],
  );

  const renderMermaidExport = useCallback(
    (exportedElements) => (
      <div className="Card mermaid-export-card">
        <h2>Mermaid</h2>
        <div className="Card-details">
          Export the complete scene as a Mermaid flowchart.
        </div>
        <button
          type="button"
          className="ToolIcon_type_button ToolIcon_size_medium Card-button ToolIcon_type_button--show ToolIcon"
          title="Export to Mermaid"
          aria-label="Export to Mermaid"
          onClick={() => {
            let downloadUrl = null;

            try {
              const { mermaid, warnings } = excalidrawToMermaid(exportedElements);
              const blob = new Blob([mermaid], {
                type: "text/plain;charset=utf-8",
              });
              const downloadLink = document.createElement("a");

              downloadUrl = URL.createObjectURL(blob);
              downloadLink.href = downloadUrl;
              downloadLink.download = toMermaidDownloadFilename(fileName);
              downloadLink.click();

              excalidrawAPI?.setToast({
                message:
                  warnings.length > 0
                    ? `Mermaid export completed with omissions: ${warnings.join(" ")}`
                    : "Mermaid file exported.",
                closable: warnings.length > 0,
                duration: warnings.length > 0 ? 8000 : 3000,
              });
            } catch (error) {
              excalidrawAPI?.setToast({
                message: `Mermaid export failed: ${error instanceof Error ? error.message : "Unknown error."}`,
                closable: true,
                duration: 8000,
              });
            } finally {
              if (downloadUrl !== null) {
                URL.revokeObjectURL(downloadUrl);
              }
            }
          }}
        >
          <div className="ToolIcon__label">Export to Mermaid</div>
        </button>
      </div>
    ),
    [fileName, excalidrawAPI],
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

          <p className="login-footnote">
            Este proyecto es un fork de{" "}
            <a
              href="https://github.com/excalidraw/excalidraw"
              target="_blank"
              rel="noreferrer"
            >
              Excalidraw
            </a>
            , el proyecto open source original.
          </p>
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
              export: {
                renderCustomUI: renderMermaidExport,
              },
            },
          }}
        >
          <MainMenu>
            <MainMenu.Item
              onSelect={() => {
                setAiError("");
                setAiDialogOpen(true);
              }}
            >
              Generate with AI
            </MainMenu.Item>
            <MainMenu.Separator />
            {isAdmin ? (
              <>
                <MainMenu.Item onSelect={() => setAdminPanelOpen(true)}>
                  Gestion de usuarios
                </MainMenu.Item>
                <MainMenu.Separator />
              </>
            ) : null}
            <MainMenu.DefaultItems.LoadScene />
            <MainMenu.DefaultItems.SaveToActiveFile />
            <MainMenu.DefaultItems.Export />
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.CommandPalette />
            <MainMenu.DefaultItems.Help />
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.Separator />
            <MainMenu.DefaultItems.ToggleTheme />
          </MainMenu>
        </Excalidraw>

        {panelOpen ? (
          <section className="storage-panel">
            <div className="storage-panel-header">
              <span className="storage-user-badge">{authUser.displayName}</span>
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

        {aiDialogOpen ? (
          <div
            className="ai-dialog-overlay"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !aiBusy) {
                closeAiDialog();
              }
            }}
          >
            <form
              className="ai-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="ai-dialog-title"
              onSubmit={generateDiagram}
            >
              <div className="ai-dialog-header">
                <div>
                  <h1 id="ai-dialog-title">Generate with AI</h1>
                  <p>Describe the flowchart to add beside your current work.</p>
                </div>
                <button
                  type="button"
                  className="panel-toggle"
                  onClick={closeAiDialog}
                  aria-label={aiBusy ? "Cancel generation" : "Close AI generator"}
                  title={aiBusy ? "Cancel generation" : "Close AI generator"}
                >
                  ×
                </button>
              </div>

              <label className="ai-prompt-field">
                <span>Diagram description</span>
                <textarea
                  value={aiPrompt}
                  onChange={(event) => setAiPrompt(event.target.value)}
                  maxLength={4000}
                  rows={7}
                  placeholder="For example: a support request moves through triage, approval, implementation, and closure."
                  autoFocus
                  disabled={aiBusy}
                  required
                />
              </label>

              <div className="ai-dialog-meta">
                <span>{aiPrompt.length}/4000</span>
                <span>No API key is sent to the browser.</span>
              </div>

              {aiError ? (
                <p className="login-error" role="alert">
                  {aiError}
                </p>
              ) : null}

              <div className="ai-dialog-actions">
                <button type="submit" disabled={aiBusy || !aiPrompt.trim()}>
                  {aiBusy ? "Generating..." : "Generate diagram"}
                </button>
                <button
                  type="button"
                  className="admin-secondary-button"
                  onClick={closeAiDialog}
                >
                  {aiBusy ? "Cancel" : "Close"}
                </button>
              </div>
            </form>
          </div>
        ) : null}

        {adminPanelOpen && isAdmin ? (
          <section className="admin-panel-overlay">
            <div className="admin-panel">
              <div className="admin-panel-header">
                <div>
                  <h1>Gestion de usuarios</h1>
                  <p>Administra acceso, actividad y contenido por usuario.</p>
                </div>
                <button
                  type="button"
                  className="panel-toggle"
                  onClick={() => {
                    setAdminPanelOpen(false);
                    resetAdminForm();
                  }}
                  aria-label="Cerrar gestion de usuarios"
                  title="Cerrar gestion de usuarios"
                >
                  ×
                </button>
              </div>

              <div className="admin-panel-grid">
                <form className="admin-form" onSubmit={submitAdminUser}>
                  <div className="section-heading">
                    <h2>{adminForm.id === null ? "Nuevo usuario" : "Editar usuario"}</h2>
                  </div>

                  <label className="login-field">
                    <span>Usuario</span>
                    <input
                      value={adminForm.username}
                      onChange={(event) =>
                        setAdminForm((currentValue) => ({
                          ...currentValue,
                          username: event.target.value,
                        }))
                      }
                      placeholder="usuario"
                      disabled={adminForm.id !== null || adminBusy}
                      required
                    />
                  </label>

                  <label className="login-field">
                    <span>Nombre visible</span>
                    <input
                      value={adminForm.displayName}
                      onChange={(event) =>
                        setAdminForm((currentValue) => ({
                          ...currentValue,
                          displayName: event.target.value,
                        }))
                      }
                      placeholder="Opcional"
                      disabled={adminBusy}
                    />
                  </label>

                  <label className="login-field">
                    <span>
                      {adminForm.id === null
                        ? "Password"
                        : "Nueva password"}
                    </span>
                    <input
                      type="password"
                      value={adminForm.password}
                      onChange={(event) =>
                        setAdminForm((currentValue) => ({
                          ...currentValue,
                          password: event.target.value,
                        }))
                      }
                      placeholder={adminForm.id === null ? "Minimo 8 caracteres" : "Dejar en blanco para mantenerla"}
                      disabled={adminBusy}
                      required={adminForm.id === null}
                    />
                  </label>

                  <label className="admin-checkbox">
                    <input
                      type="checkbox"
                      checked={adminForm.isActive}
                      onChange={(event) =>
                        setAdminForm((currentValue) => ({
                          ...currentValue,
                          isActive: event.target.checked,
                        }))
                      }
                      disabled={adminBusy || adminForm.id === authUser.id}
                    />
                    <span>Usuario activo</span>
                  </label>

                  <div className="admin-form-actions">
                    <button type="submit" disabled={adminBusy}>
                      {adminForm.id === null ? "Crear usuario" : "Guardar cambios"}
                    </button>
                    <button
                      type="button"
                      className="admin-secondary-button"
                      onClick={resetAdminForm}
                      disabled={adminBusy}
                    >
                      Limpiar
                    </button>
                    <button
                      type="button"
                      className="admin-secondary-button"
                      onClick={() => void refreshAdminUsers()}
                      disabled={adminBusy}
                    >
                      Recargar
                    </button>
                  </div>
                </form>

                <div className="admin-user-list">
                  <div className="section-heading">
                    <h2>Usuarios</h2>
                    <span className="storage-panel-count">{adminUsers.length}</span>
                  </div>

                  {adminUsers.length === 0 ? (
                    <p className="empty-state">No hay usuarios registrados.</p>
                  ) : (
                    <ul className="admin-user-items">
                      {adminUsers.map((user) => (
                        <li key={user.id} className="admin-user-card">
                          <div className="admin-user-card-header">
                            <div>
                              <strong>{user.username}</strong>
                              <span className={`admin-user-state${user.isActive ? "" : " is-inactive"}`}>
                                {user.isActive ? "Activo" : "Inactivo"}
                              </span>
                            </div>
                            <div className="admin-user-card-actions">
                              <button
                                type="button"
                                className="admin-secondary-button"
                                onClick={() => editAdminUser(user)}
                                disabled={adminBusy}
                              >
                                Editar
                              </button>
                              <button
                                type="button"
                                className="admin-danger-button"
                                onClick={() => void deleteAdminUser(user)}
                                disabled={adminBusy || user.id === authUser.id}
                              >
                                Eliminar
                              </button>
                            </div>
                          </div>
                          <dl className="admin-user-metadata">
                            <div>
                              <dt>Nombre</dt>
                              <dd>{user.displayName}</dd>
                            </div>
                            <div>
                              <dt>Ultimo login</dt>
                              <dd>{formatTimestamp(user.lastLoginAt)}</dd>
                            </div>
                            <div>
                              <dt>Diagramas</dt>
                              <dd>{user.diagramCount}</dd>
                            </div>
                          </dl>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              <p className={`status status-${adminStatus.kind}`}>{adminStatus.message}</p>
            </div>
          </section>
        ) : null}
      </main>
    </div>
  );
}

export default App;
