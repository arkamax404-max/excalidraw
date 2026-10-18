import test from "node:test";
import assert from "node:assert/strict";
import { serializeScene } from "./scene-serialization.mjs";

// Model only the public database serializer's relevant contract. The browser suite
// separately exercises the installed library, real UI and HTTP save/load path.
const canonical = (elements, appState, _files, mode) => {
  assert.equal(mode, "database");
  return JSON.stringify({
    type: "excalidraw", version: 2, source: "canonical-export-source",
    elements: elements.filter(e => !e.isDeleted).map(e =>
      ["line", "arrow"].includes(e.type) ? { ...e, lastCommittedPoint: null } : e),
    appState: { viewBackgroundColor: appState.viewBackgroundColor },
  }, null, 2);
};
const state = { viewBackgroundColor: "#ffffff", collaborators: { private: true },
  selectedElementIds: { image: true }, scrollX: 123, editingTextElement: "private" };
const image = { id: "image", type: "image", fileId: "binary", isDeleted: false };
const binary = { id: "binary", dataURL: "data:image/png;base64,AA==", mimeType: "image/png",
  created: 123, lastRetrieved: 456, customMetadata: { retained: true } };
const parse = (elements, files = {}) => JSON.parse(serializeScene(elements, state, files, canonical));
const freeze = value => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

test("retains referenced binary data and all metadata, excludes another document's cache", () => {
  const result = parse([image], { binary, other: { ...binary, id: "other", dataURL: "private" } });
  assert.deepEqual(result.files, { binary });
});

test("retains tombstone identity, versions, geometry and links in scene order", () => {
  const deleted = { ...image, isDeleted: true, version: 9, versionNonce: 321,
    x: 7, y: -4, width: 12, height: 18, angle: 1, groupIds: ["group"],
    frameId: "frame", boundElements: [{ id: "arrow", type: "arrow" }], link: "https://example.invalid" };
  const live = { id: "live", type: "rectangle", isDeleted: false };
  const result = parse([deleted, live], { binary });
  assert.deepEqual(result.elements, [deleted, live]);
  assert.deepEqual(result.files, { binary });
});

test("uses canonical app-state cleaning, export metadata and linear-element cleaning", () => {
  const line = { id: "line", type: "line", isDeleted: true, points: [[0, 0], [10, 10]], lastCommittedPoint: [10, 10] };
  const result = parse([line]);
  assert.deepEqual(result, { type: "excalidraw", version: 2, source: "canonical-export-source",
    elements: [{ ...line, lastCommittedPoint: null }], appState: { viewBackgroundColor: "#ffffff" } });
});

test("does not mutate frozen elements, state or file cache", () => {
  const elements = freeze([{ ...image, isDeleted: true }]);
  const files = freeze({ binary: structuredClone(binary) });
  const appState = freeze(structuredClone(state));
  const before = JSON.stringify({ elements, files, appState });
  serializeScene(elements, appState, files, canonical);
  assert.equal(JSON.stringify({ elements, files, appState }), before);
});

test("unaffected scenes retain the exact canonical JSON, without an empty files property", () => {
  for (const elements of [[], [{ id: "plain", type: "rectangle", isDeleted: false }]]) {
    const cache = { other: binary };
    assert.equal(serializeScene(elements, state, cache, canonical), canonical(elements, state, cache, "database"));
  }
});

test("missing references are not fabricated and inherited/non-image cache keys are not copied", () => {
  const files = Object.create({ binary });
  files.other = binary;
  const result = parse([image, { ...image, id: "missing", fileId: "missing", isDeleted: true },
    { type: "rectangle", id: "not-image", fileId: "other" }], files);
  assert.equal(Object.hasOwn(result, "files"), false);
  assert.equal(result.elements[1].isDeleted, true);
});
