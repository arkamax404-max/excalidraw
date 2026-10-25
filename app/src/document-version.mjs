export const normalizeDocumentName = (value) => String(value || "")
  .normalize("NFKC").replace(/[^\w\- ]+/g, "-").replace(/\s+/g, "-")
  .replace(/-+/g, "-").replace(/^[-_. ]+|[-_. ]+$/g, "").toLowerCase().slice(0, 80) || "diagrama-1";

export const documentContext = (account, name, previous) => ({
  account, name, generation: (previous?.generation ?? 0) + 1, identity: null,
});
export const renameDocument = (state, name) => ({ ...state, name, generation: state.generation + 1 });
export const beginDocumentOperation = (state) => ({ ...state, generation: state.generation + 1 });
export const beginReconciliation = (state) => ({ state, generation: state.generation });
export const canApplyServerDocument = (current, token) =>
  current === token.state && current.generation === token.generation;
export const documentHeaders = (state) => state.account && state.identity?.name === normalizeDocumentName(state.name)
  ? { "If-Match": state.identity.etag } : {};

export function acknowledgeDocument(current, operation, result) {
  if (current !== operation || result.status !== 200) return null;
  const name = result.payload?.file?.name;
  if (typeof name !== "string" || name !== normalizeDocumentName(operation.name)) return null;
  const parts = /^"([1-9][0-9]{0,18}):([1-9][0-9]{0,18})"$/.exec(result.etag);
  const valid = parts && parts.slice(1).every(value => BigInt(value) <= 9223372036854775807n);
  return { ...current, name, identity: valid ? { name, id: parts[1], revision: parts[2], etag: result.etag } : null };
}

export function documentError(error) {
  return error.status === 412 || error.status === 428
    ? "Conflicto: el servidor tiene otra version o falta su identidad. Tu dibujo sigue intacto. Selecciona el diagrama para cargar la version del servidor (reemplaza el lienzo), o guarda con otro nombre."
    : error.message;
}

export async function readApiResponse(response, unauthorized, metadata = false) {
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : null;
  if (response.status === 401) {
    const message = payload?.error || "Tu sesion ha expirado.";
    unauthorized(message);
    const error = new Error(message);
    error.status = 401;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(payload?.error || "Se produjo un error inesperado.");
    error.status = response.status;
    throw error;
  }
  return metadata ? { payload, status: response.status, etag: response.headers.get("etag"),
    warning: response.headers.get("x-backup-warning") || payload?.warning } : payload;
}
