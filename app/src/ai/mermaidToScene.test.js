import assert from "node:assert/strict";
import test from "node:test";
import {
  convertAndInsertMermaidCore,
  placeGeneratedElements,
} from "./mermaidSceneCore.js";

test("places a generated diagram beside existing work", () => {
  const placed = placeGeneratedElements(
    [{ id: "old", x: 10, y: 20, width: 100, height: 40 }],
    [{ id: "new", x: 0, y: 0, width: 50, height: 20 }],
  );

  assert.equal(placed[0].x, 190);
  assert.equal(placed[0].y, 20);
});

test("converts and inserts generated Mermaid without replacing the scene", async () => {
  const calls = [];
  let parsedMermaid = "";
  const oldElement = { id: "old", x: 0, y: 0, width: 100, height: 50 };
  const newElement = { id: "new", x: 0, y: 0, width: 60, height: 30 };
  const file = { id: "file-1", dataURL: "data:image/svg+xml;base64,PHN2Zy8+" };
  const excalidrawAPI = {
    getSceneElementsIncludingDeleted: () => [oldElement],
    addFiles: (files) => calls.push(["addFiles", files]),
    updateScene: (scene) => calls.push(["updateScene", scene]),
  };

  const inserted = await convertAndInsertMermaidCore({
    mermaid: "flowchart TD\nA --> B",
    excalidrawAPI,
    parse: async (mermaid) => {
      parsedMermaid = mermaid;
      return { elements: [{ type: "rectangle" }], files: { one: file } };
    },
    convert: () => [newElement],
    captureUpdate: "IMMEDIATELY",
  });

  assert.equal(inserted.length, 1);
  assert.equal(parsedMermaid, "flowchart TD\nA --> B");
  assert.deepEqual(calls[0], ["addFiles", [file]]);
  assert.equal(calls[1][0], "updateScene");
  assert.equal(calls[1][1].elements[0], oldElement);
  assert.equal(calls[1][1].elements[1].id, "new");
  assert.equal(calls[1][1].captureUpdate, "IMMEDIATELY");
  assert.deepEqual(calls[1][1].appState.selectedElementIds, { new: true });
});
