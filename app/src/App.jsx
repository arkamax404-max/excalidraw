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

import { serializeScene } from "./scene-serialization.mjs";
import { mayApplyScene, openRealtime } from "./realtime-client.mjs";
import { documentContext, renameDocument, beginDocumentOperation, documentHeaders,
  acknowledgeDocument, readApiResponse, documentError, normalizeDocumentName,
  beginReconciliation, canApplyServerDocument, documentTarget,
  documentPayloadName } from "./document-version.mjs";
import { validUsername, sharePath, memberPath, memberNames } from "./sharing.mjs";

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
  const [loadedIdentity, setLoadedIdentity] = useState(null);
  const [shareUsername, setShareUsername] = useState("");
  const [members, setMembers] = useState([]);
  const [shareBusy, setShareBusy] = useState(false);
  const [availableFiles, setAvailableFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
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
  const documentVersion = useRef(documentContext(null, DEFAULT_FILE_NAME));
  const saveConflict = useRef(null);
  const pendingReconciliation = useRef(null);
  const editorNode = useRef(null);
  const realtime = useRef(null);
  const persistedScene = useRef(null);
  // Applying a remote scene fires onChange; it must not be echoed back.
  const remoteAppliedAt = useRef(0);
  const localPointer = useRef(null);
  const closeRealtime = useCallback(() => {
    realtime.current?.close();
    realtime.current = null;
  }, []);
  useEffect(() => closeRealtime, [closeRealtime]);
  const connectRealtime = useCallback((identity) => {
    if (realtime.current?.diagramId === identity?.id) return;
    closeRealtime();
    const ownerWindow = editorNode.current?.ownerDocument.defaultView;
    if (!identity || !ownerWindow || !excalidrawAPI) return;
    const snapshot = () => serializeScene(excalidrawAPI.getSceneElementsIncludingDeleted(),
      excalidrawAPI.getAppState(), excalidrawAPI.getFiles(), serializeAsJSON);
    realtime.current = openRealtime({
      diagramId: identity.id,
      ownerWindow,
      getFiles: () => excalidrawAPI.getFiles(),
      onFiles: (files) => {
        const wasClean = snapshot() === persistedScene.current;
        if (files.length) excalidrawAPI.addFiles(files);
        if (wasClean) persistedScene.current = snapshot();
      },
      onCollaborators: (collaborators) => excalidrawAPI.updateScene({ collaborators }),
      onScene: (frame) => {
        if (!mayApplyScene(frame, snapshot() !== persistedScene.current)) return;
        remoteAppliedAt.current = Date.now();
        excalidrawAPI.updateScene({ elements: frame.payload.elements });
        persistedScene.current = snapshot();
      },
      onAuthorizationFailure: () => {
        const message = "Conexion detenida: ya no tienes acceso al diagrama.";
        setStatus(createStatus("error", message));
        excalidrawAPI.setToast({ message, closable: true });
      },
    });
  }, [closeRealtime, excalidrawAPI]);
  const trackReconciliationChanges = useCallback((elements, appState, files) => {
    realtime.current?.publishFiles();
    if (Date.now() - remoteAppliedAt.current > 250) realtime.current?.publishScene(elements);
    const pending = pendingReconciliation.current;
    if (pending && canApplyServerDocument(documentVersion.current, pending.token)
      && serializeScene(elements, appState, files, serializeAsJSON) !== pending.scene) {
      // Keep request ownership (including HTTP errors), but invalidate its snapshot.
      documentVersion.current.generation += 1;
    }
  }, []);
  const resetDocumentIdentity = (account, name = DEFAULT_FILE_NAME) => {
    closeRealtime();
    documentVersion.current = documentContext(account, name, documentVersion.current);
    setLoadedIdentity(null);
    setMembers([]);
    setShareUsername("");
  };

  const currentFileName = useMemo(() => {
    const trimmedValue = fileName.trim();
    return trimmedValue || DEFAULT_FILE_NAME;
  }, [fileName]);

  const isAdmin = authUser?.isAdmin === true;

  const handleUnauthorized = useCallback((message = "Tu sesion ha expirado.") => {
    resetDocumentIdentity(null);
    setAuthUser(null);
    setAvailableFiles([]);
    setFileName(DEFAULT_FILE_NAME);
    setPanelOpen(false);
    setAdminPanelOpen(false);
    setAdminUsers([]);
    setAdminForm(ADMIN_FORM_INITIAL_STATE);
    setStatus(createStatus("error", message));
  }, []);

  const apiRequest = useCallback(
    async (url, options = {}, metadata = false, operation) => {
      const headers = { ...(options.headers || {}) };
      if (options.body && !headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
      }

      const response = await fetch(url, {
        credentials: "include",
        ...options,
        headers,
      });
      return readApiResponse(response, (message) => {
        if (!operation || documentVersion.current === operation) handleUnauthorized(message);
      }, metadata);
    },
    [handleUnauthorized],
  );

  const refreshFiles = useCallback(async () => {
    if (!authUser) {
      setAvailableFiles([]);
      return;
    }

    try {
      const [own, accessible] = await Promise.all([
        apiRequest("/api/files"),
        apiRequest("/api/diagrams"),
      ]);
      const ownFiles = own?.files ?? [];
      const ownedNames = new Set(ownFiles.map((file) => file.name));
      // A diagram only in the accessible listing is shared with this user and is
      // opened by id; names are per owner, so they never address the same file.
      const shared = (accessible?.diagrams ?? [])
        .filter((diagram) => !ownedNames.has(diagram.name))
        .map((diagram) => ({ ...diagram, kind: "diagram", shared: true }));
      setAvailableFiles([...ownFiles.map((file) => ({ ...file, kind: "file" })), ...shared]);
    } catch (error) {
      if (error.status !== 401) {
        setStatus(createStatus("error", error.message));
      }
    }
  }, [apiRequest, authUser]);

  const loadMembers = useCallback(async (identity) => {
    const path = sharePath(identity);
    if (!path) {
      setMembers([]);
      return;
    }
    try {
      setMembers(memberNames(await apiRequest(path)));
    } catch (error) {
      if (error.status !== 401) {
        setStatus(createStatus("error", error.message));
      }
    }
  }, [apiRequest]);

  const shareMember = useCallback(async () => {
    const path = sharePath(loadedIdentity);
    const username = shareUsername.trim();
    if (!path || !validUsername(username)) {
      setStatus(createStatus("error", "Escribe un usuario valido para compartir."));
      return;
    }
    setShareBusy(true);
    try {
      await apiRequest(path, { method: "POST", body: JSON.stringify({ username }) });
      setShareUsername("");
      setStatus(createStatus("success", `${username} ya puede abrir este diagrama.`));
      await loadMembers(loadedIdentity);
    } catch (error) {
      if (error.status !== 401) {
        setStatus(createStatus("error", error.message));
      }
    } finally {
      setShareBusy(false);
    }
  }, [apiRequest, loadMembers, loadedIdentity, shareUsername]);

  const revokeMember = useCallback(async (username) => {
    const path = memberPath(loadedIdentity, username);
    if (!path) return;
    setShareBusy(true);
    try {
      await apiRequest(path, { method: "DELETE" });
      setStatus(createStatus("success", `${username} ya no tiene acceso a este diagrama.`));
      await loadMembers(loadedIdentity);
    } catch (error) {
      if (error.status !== 401) {
        setStatus(createStatus("error", error.message));
      }
    } finally {
      setShareBusy(false);
    }
  }, [apiRequest, loadMembers, loadedIdentity]);

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
          resetDocumentIdentity(payload.user.id);
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

        resetDocumentIdentity(payload.user.id);
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
    closeRealtime();
    resetDocumentIdentity(documentVersion.current.account);
    setBusy(true);

    try {
      await apiRequest("/api/auth/logout", { method: "POST" });
      resetDocumentIdentity(null);
      setAuthUser(null);
      setAvailableFiles([]);
      setFileName(DEFAULT_FILE_NAME);
      setPanelOpen(false);
      setAdminPanelOpen(false);
      setAdminUsers([]);
      setAdminForm(ADMIN_FORM_INITIAL_STATE);
      setStatus(createStatus("info", "Sesion cerrada."));
    } catch (error) {
      setStatus(createStatus("error", error.message));
    } finally {
      setBusy(false);
    }
  }, [apiRequest, closeRealtime]);

  const saveDiagram = useCallback(async () => {
    if (!excalidrawAPI) {
      return;
    }

    setBusy(true);
    setStatus(createStatus("info", "Guardando diagrama..."));
    const operation = beginDocumentOperation(documentVersion.current);
    documentVersion.current = operation;

    try {
      const scene = serializeScene(
        excalidrawAPI.getSceneElementsIncludingDeleted(),
        excalidrawAPI.getAppState(),
        excalidrawAPI.getFiles(),
        serializeAsJSON,
      );

      const target = documentTarget({
        kind: documentVersion.current.identity?.kind,
        id: documentVersion.current.identity?.id,
        name: currentFileName,
      });
      // Renaming belongs to the owner: the id endpoint accepts member writes but
      // keeps the stored name, so refuse instead of sending a save without If-Match.
      if (operation.identity?.kind === "diagram"
        && normalizeDocumentName(currentFileName) !== operation.identity.name) {
        setStatus(createStatus("error", "Solo el propietario puede cambiar el nombre de un diagrama compartido."));
        return;
      }
      const result = await apiRequest(target.path,
        { method: "PUT", body: scene, headers: documentHeaders(operation) }, true, operation,
      );
      const next = acknowledgeDocument(documentVersion.current, operation, result);
      if (!next) return;
      documentVersion.current = next;
      persistedScene.current = scene;
      setLoadedIdentity(next.identity);
      connectRealtime(next.identity);
      realtime.current?.publishPersistedScene(next.identity?.id, JSON.parse(scene).elements);
      setFileName(next.name);
      setStatus(createStatus(result.warning ? "info" : "success",
        `Guardado como ${documentPayloadName(result.payload)}.${result.warning ? " PostgreSQL confirmado; fallo el respaldo." : ""}${!next.identity ? " Falta la version: carga el diagrama antes de reemplazarlo." : ""}`));
      await refreshFiles();
    } catch (error) {
      if (documentVersion.current === operation) {
        if (error.status === 412 || error.status === 428) saveConflict.current = operation;
        setStatus(createStatus("error", documentError(error)));
      }
    } finally {
      setBusy(false);
    }
  }, [apiRequest, connectRealtime, currentFileName, excalidrawAPI, refreshFiles]);

  const loadDiagram = useCallback(
    async (entry) => {
      if (!excalidrawAPI) {
        return;
      }

      const name = entry.name;
      const target = documentTarget(entry);
      setBusy(true);
      setStatus(createStatus("info", `Cargando ${name}...`));
      closeRealtime();
      const previous = documentVersion.current;
      const operation = beginDocumentOperation(renameDocument(previous, name));
      documentVersion.current = operation;
      const reconciliation = saveConflict.current === previous
        && normalizeDocumentName(name) === normalizeDocumentName(previous.name)
        ? {
          token: beginReconciliation(operation),
          scene: serializeScene(excalidrawAPI.getSceneElementsIncludingDeleted(),
            excalidrawAPI.getAppState(), excalidrawAPI.getFiles(), serializeAsJSON),
        } : null;
      pendingReconciliation.current = reconciliation;
      if (reconciliation) saveConflict.current = operation;

      try {
        const result = await apiRequest(target.path, {}, true, operation);
        if (reconciliation && !canApplyServerDocument(documentVersion.current, reconciliation.token)) {
          setStatus(createStatus("info", "El lienzo conserva los cambios locales porque cambio mientras se cargaba la version del servidor."));
          return;
        }
        const next = acknowledgeDocument(documentVersion.current, operation, result);
        if (!next) return;
        pendingReconciliation.current = null;
        documentVersion.current = next;
        setLoadedIdentity(next.identity);
        void loadMembers(next.identity);
        const payload = result.payload;
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
        persistedScene.current = serializeScene(excalidrawAPI.getSceneElementsIncludingDeleted(),
          excalidrawAPI.getAppState(), excalidrawAPI.getFiles(), serializeAsJSON);
        connectRealtime(next.identity);
        setFileName(payload.file?.name ?? payload.diagram?.name);
        setStatus(
          createStatus("success", `${documentPayloadName(payload)} cargado.`),
        );
      } catch (error) {
        if (documentVersion.current === operation) {
          documentVersion.current = previous;
          setStatus(createStatus("error", documentError(error)));
        }
      } finally {
        if (pendingReconciliation.current === reconciliation) pendingReconciliation.current = null;
        setBusy(false);
      }
    },
    [apiRequest, closeRealtime, connectRealtime, excalidrawAPI, loadMembers],
  );

  const deleteDiagram = useCallback(
    async (name) => {
      setBusy(true);
      setStatus(createStatus("info", `Eliminando ${name}...`));

      try {
        const payload = await apiRequest(`/api/files/${encodeURIComponent(name)}`, {
          method: "DELETE",
        });

        const current = documentVersion.current;
        if (current.identity?.name === normalizeDocumentName(name)) {
          resetDocumentIdentity(current.account, current.name);
        }
        if (normalizeDocumentName(current.name) === normalizeDocumentName(name)) {
          resetDocumentIdentity(documentVersion.current.account);
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
    [apiRequest, refreshFiles],
  );

  const createBlankDiagram = useCallback(() => {
    if (!excalidrawAPI) {
      return;
    }

    resetDocumentIdentity(documentVersion.current.account);
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
    <div className="app-shell" ref={editorNode}>
      <main className="editor-shell" onPointerLeave={() => {
        if (localPointer.current) realtime.current?.publishPointer({ button: "up", pointer: localPointer.current });
      }}>
        <Excalidraw
          excalidrawAPI={setExcalidrawAPI}
          onChange={trackReconciliationChanges}
          onPointerUpdate={({ pointer, button }) => {
            const tool = excalidrawAPI?.getAppState().activeTool.type === "laser" ? "laser" : "pointer";
            localPointer.current = { x: pointer.x, y: pointer.y, tool };
            realtime.current?.publishPointer({ pointer: localPointer.current, button });
          }}
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
                  onChange={(event) => {
                    documentVersion.current = renameDocument(documentVersion.current, event.target.value);
                    setFileName(event.target.value);
                  }}
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

              {sharePath(loadedIdentity) ? (
                <div className="storage-secondary-row">
                  <input
                    aria-label="Usuario para compartir"
                    placeholder="usuario"
                    value={shareUsername}
                    onChange={(event) => setShareUsername(event.target.value)}
                    disabled={shareBusy}
                  />
                  <button type="button" onClick={() => void shareMember()}
                    disabled={shareBusy || !validUsername(shareUsername)}>
                    Compartir
                  </button>
                  <button type="button" onClick={() => void loadMembers(loadedIdentity)}
                    disabled={shareBusy}>
                    Accesos
                  </button>
                </div>
              ) : null}

              {members.length > 0 ? (
                <ul className="file-list">
                  {members.map((member) => (
                    <li key={member} className="file-row">
                      <span className="file-name">{member}</span>
                      <button
                        type="button"
                        className="file-delete-button"
                        onClick={() => void revokeMember(member)}
                        disabled={shareBusy}
                        aria-label={`Quitar ${member}`}
                        title={`Quitar ${member}`}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm1 6h2v8h-2V9Zm4 0h2v8h-2V9ZM7 9h2v8H7V9Zm-1 11a2 2 0 0 1-2-2V8h16v10a2 2 0 0 1-2 2H6Z" />
                        </svg>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}

              <div className="section-heading">
                <h2>Mis diagramas</h2>
                <span className="storage-panel-count">{availableFiles.length}</span>
              </div>

              {availableFiles.length === 0 ? (
                <p className="empty-state">Todavia no tienes diagramas guardados.</p>
              ) : (
                <ul className="file-list">
                  {availableFiles.map((item) => (
                    <li key={item.kind === "diagram" ? `d:${item.id}` : `f:${item.name}`} className="file-row">
                      <button
                        type="button"
                        className="file-button"
                        onClick={() => void loadDiagram(item)}
                        disabled={busy}
                      >
                        <span className="file-name">{item.fileName}</span>
                        <small>
                          {item.shared ? "Compartido · " : ""}
                          {new Date(item.updatedAt).toLocaleString("es-ES")}
                        </small>
                      </button>
                      {item.shared ? null : (
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
                      )}
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
