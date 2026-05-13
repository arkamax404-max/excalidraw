import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Excalidraw,
  MainMenu,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import "./App.css";

const DEFAULT_FILE_NAME = "diagrama-1";

const getDefaultStatus = (message = "Listo.") => ({
  kind: "info",
  message,
});

function App() {
  const [excalidrawAPI, setExcalidrawAPI] = useState(null);
  const [fileName, setFileName] = useState(DEFAULT_FILE_NAME);
  const [availableFiles, setAvailableFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [status, setStatus] = useState(getDefaultStatus());

  const currentFileName = useMemo(() => {
    const trimmedValue = fileName.trim();
    return trimmedValue || DEFAULT_FILE_NAME;
  }, [fileName]);

  const refreshFiles = useCallback(async () => {
    try {
      const response = await fetch("/api/files");
      if (!response.ok) {
        throw new Error("No se pudo obtener el listado de diagramas.");
      }

      const payload = await response.json();
      setAvailableFiles(payload.files ?? []);
    } catch (error) {
      setStatus({
        kind: "error",
        message: error.message,
      });
    }
  }, []);

  useEffect(() => {
    void refreshFiles();
  }, [refreshFiles]);

  const saveDiagram = useCallback(async () => {
    if (!excalidrawAPI) {
      return;
    }

    setBusy(true);
    setStatus(getDefaultStatus("Guardando diagrama..."));

    try {
      const scene = serializeAsJSON(
        excalidrawAPI.getSceneElementsIncludingDeleted(),
        excalidrawAPI.getAppState(),
        excalidrawAPI.getFiles(),
        "database",
      );

      const response = await fetch(
        `/api/files/${encodeURIComponent(currentFileName)}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: scene,
        },
      );

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "No se pudo guardar el diagrama.");
      }

      setFileName(payload.file.name);
      setStatus({
        kind: "success",
        message: `Guardado como ${payload.file.fileName}.`,
      });
      await refreshFiles();
    } catch (error) {
      setStatus({
        kind: "error",
        message: error.message,
      });
    } finally {
      setBusy(false);
    }
  }, [currentFileName, excalidrawAPI, refreshFiles]);

  const loadDiagram = useCallback(
    async (name) => {
      if (!excalidrawAPI) {
        return;
      }

      setBusy(true);
      setStatus(getDefaultStatus(`Cargando ${name}...`));

      try {
        const response = await fetch(`/api/files/${encodeURIComponent(name)}`);
        const payload = await response.json();

        if (!response.ok) {
          throw new Error(payload.error || "No se pudo cargar el diagrama.");
        }

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
        setStatus({
          kind: "success",
          message: `${payload.file.fileName} cargado.`,
        });
      } catch (error) {
        setStatus({
          kind: "error",
          message: error.message,
        });
      } finally {
        setBusy(false);
      }
    },
    [excalidrawAPI],
  );

  const deleteDiagram = useCallback(
    async (name) => {
      setBusy(true);
      setStatus(getDefaultStatus(`Eliminando ${name}...`));

      try {
        const response = await fetch(`/api/files/${encodeURIComponent(name)}`, {
          method: "DELETE",
        });
        const payload = await response.json();

        if (!response.ok) {
          throw new Error(payload.error || "No se pudo eliminar el diagrama.");
        }

        if (currentFileName === name) {
          setFileName(DEFAULT_FILE_NAME);
        }

        setStatus({
          kind: "success",
          message: `${payload.file.fileName} eliminado.`,
        });
        await refreshFiles();
      } catch (error) {
        setStatus({
          kind: "error",
          message: error.message,
        });
      } finally {
        setBusy(false);
      }
    },
    [currentFileName, refreshFiles],
  );

  const createBlankDiagram = useCallback(() => {
    if (!excalidrawAPI) {
      return;
    }

    excalidrawAPI.resetScene();
    excalidrawAPI.history.clear();
    setFileName(DEFAULT_FILE_NAME);
    setStatus(getDefaultStatus("Lienzo reiniciado."));
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
              <div className="storage-panel-heading">
                <h1>Guardar en servidor</h1>
                <span>{availableFiles.length}</span>
              </div>
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

            <>
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
                  <h2>Diagramas guardados</h2>
                </div>

                {availableFiles.length === 0 ? (
                  <p className="empty-state">Todavia no hay diagramas guardados.</p>
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
            </>
          </section>
        ) : null}
      </main>
    </div>
  );
}

export default App;
