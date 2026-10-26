import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDocumentName, documentContext, renameDocument, beginDocumentOperation,
  documentHeaders, acknowledgeDocument, readApiResponse, documentError,
  beginReconciliation, canApplyServerDocument, documentTarget } from "./document-version.mjs";

const reply = (etag = '"9007199254740993:2"', warning) => ({
  payload: { file: { name: "one", fileName: "one.excalidraw" }, warning },
  etag, warning, status: 200,
});
const loaded = () => {
  const operation = beginDocumentOperation(documentContext("alice", "one"));
  return acknowledgeDocument(operation, operation, reply());
};

test("normalization matches server boundaries, not a new naming policy", () => {
  for (const [input, expected] of [[" Ａ B__é!! ", "a-b"], ["___", "diagrama-1"],
    ["a\tb", "a-b"], ["a".repeat(81), "a".repeat(80)], ["a".repeat(79) + "--z", "a".repeat(79) + "-"],
    ["", "diagrama-1"], ["A.json", "a-json"]]) {
    assert.equal(normalizeDocumentName(input), expected);
  }
});

test("only exact strong BIGINT identity is admitted and sent to its known name", () => {
  const state = loaded();
  assert.deepEqual(state.identity, { kind: "file", id: "9007199254740993", revision: "2", etag: '"9007199254740993:2"', name: "one" });
  assert.deepEqual(documentHeaders(renameDocument(state, "ＯＮＥ")), { "If-Match": '"9007199254740993:2"' });
  assert.deepEqual(documentHeaders(renameDocument(state, "existing-unknown")), {});
  assert.deepEqual(documentHeaders(documentContext("bob", "one")), {});
  for (const etag of [null, 'W/"1:2"', '"01:2"', '"1:0"', '"9223372036854775808:1"']) {
    const op = beginDocumentOperation(state);
    assert.equal(acknowledgeDocument(op, op, reply(etag)).identity, null);
  }
});

test("acknowledged canonical warning advances; failed saves never change identity or local scene", () => {
  const state = loaded();
  const op = beginDocumentOperation(state);
  const next = acknowledgeDocument(op, op, reply('"9007199254740993:3"', "diagram-backup-failed"));
  assert.equal(documentHeaders(next)["If-Match"], '"9007199254740993:3"');
  for (const status of [412, 428, 500, undefined]) {
    assert.match(documentError({ status, message: "offline" }), status === 412 || status === 428 ? /cargar.*otro nombre/ : /offline/);
    assert.equal(acknowledgeDocument(op, op, { ...reply(), status }), null);
    assert.equal(documentHeaders(op)["If-Match"], '"9007199254740993:2"');
  }
});

test("name, new/load generations and blank/logout/account/delete reject late acknowledgements", () => {
  const old = beginDocumentOperation(loaded());
  for (const current of [renameDocument(old, "two"), beginDocumentOperation(old),
    ...["alice", null, "bob"].map(account => documentContext(account, "one", old))]) {
    assert.equal(acknowledgeDocument(current, old, reply()), null);
  }
  assert.deepEqual(documentHeaders(documentContext("alice", "one", old)), {});
  const fresh = beginDocumentOperation(renameDocument(old, " Fresh Name "));
  const savedAs = acknowledgeDocument(fresh, fresh, {
    ...reply('"42:1"'), payload: { file: { name: "fresh-name" } },
  });
  assert.equal(savedAs.name, "fresh-name");
  assert.deepEqual(documentHeaders(savedAs), { "If-Match": '"42:1"' });
});

test("shared diagrams are reached by id and acknowledged from a diagram payload", () => {
  assert.deepEqual(documentTarget({ name: "one" }), { kind: "file", path: "/api/files/one" });
  assert.deepEqual(documentTarget({ name: "a b", kind: "file" }), { kind: "file", path: "/api/files/a%20b" });
  assert.deepEqual(documentTarget({ name: "one", kind: "diagram", id: "7" }), { kind: "diagram", path: "/api/diagrams/7" });
  assert.deepEqual(documentTarget({ name: "one", kind: "diagram" }), { kind: "file", path: "/api/files/one" });
  const operation = beginDocumentOperation(documentContext("bob", "one"));
  const shared = acknowledgeDocument(operation, operation, {
    payload: { diagram: { name: "one", fileName: "one.excalidraw.json" } },
    etag: '"7:4"', status: 200,
  });
  assert.deepEqual(shared.identity, { kind: "diagram", id: "7", revision: "4", etag: '"7:4"', name: "one" });
  assert.deepEqual(documentTarget(shared.identity).path, "/api/diagrams/7");
  assert.deepEqual(documentHeaders(shared), { "If-Match": '"7:4"' });
  assert.equal(acknowledgeDocument(operation, operation, {
    payload: { diagram: { name: "otro" } }, etag: '"7:4"', status: 200,
  }), null);
});

test("reconciliation token authorises its unchanged document state", () => {  const state = loaded();
  const token = beginReconciliation(state);
  assert.equal(canApplyServerDocument(state, token), true);
});

test("new local operation rejects reconciliation and preserves local scene", () => {
  const state = loaded();
  const token = beginReconciliation(state);
  const localScene = { elements: [{ id: "local-edit" }] };
  const current = { ...beginDocumentOperation(state), scene: localScene };
  assert.equal(canApplyServerDocument(current, token), false);
  assert.strictEqual(current.scene, localScene);
  assert.deepEqual(current.scene, { elements: [{ id: "local-edit" }] });
});

test("rename and document switch invalidate reconciliation", () => {
  const state = loaded();
  const token = beginReconciliation(state);
  for (const current of [renameDocument(state, "two"),
    documentContext("alice", "two", state), documentContext("alice", "one", state)]) {
    assert.equal(canApplyServerDocument(current, token), false);
  }
});

test("reconciliation token never authorises another document at the same generation", () => {
  const state = documentContext("alice", "one");
  const token = beginReconciliation(state);
  for (const other of [documentContext("alice", "two"), documentContext("bob", "one")]) {
    assert.equal(other.generation, state.generation);
    assert.equal(canApplyServerDocument(other, token), false);
  }
});

test("same document state mutated in place invalidates reconciliation", () => {
  const state = loaded();
  const token = beginReconciliation(state);
  state.generation += 1;
  assert.equal(canApplyServerDocument(state, token), false);
});

test("default HTTP response semantics stay JSON/null with original errors; metadata is opt-in", async () => {
  for (const [status, body, contentType] of [[200, { files: [] }, "application/json"], [204, null, "text/plain"],
    [400, { error: "bad" }, "application/json"], [500, null, "text/plain"], [401, {}, "application/json"]]) {
    let unauthorized;
    const response = () => ({ status, ok: status < 400,
      headers: new Headers({ "content-type": contentType, ETag: '"1:2"', "X-Backup-Warning": "diagram-backup-failed" }),
      json: async () => body });
    if (status >= 400) {
      await assert.rejects(readApiResponse(response(), message => { unauthorized = message; }), error =>
        error.status === status && error.message === (body?.error || (status === 401 ? "Tu sesion ha expirado." : "Se produjo un error inesperado.")));
      assert.equal(unauthorized, status === 401 ? "Tu sesion ha expirado." : undefined);
    } else {
      assert.deepEqual(await readApiResponse(response(), () => {}), body);
      assert.deepEqual(await readApiResponse(response(), () => {}, true), {
        payload: body, status, etag: '"1:2"', warning: "diagram-backup-failed",
      });
    }
  }
});
