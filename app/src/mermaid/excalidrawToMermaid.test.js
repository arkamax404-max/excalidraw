import assert from "node:assert/strict";
import test from "node:test";

import { excalidrawToMermaid } from "./excalidrawToMermaid.js";

const element = (id, type, properties = {}) => ({
  id,
  type,
  isDeleted: false,
  ...properties,
});

test("exports supported node shapes with stable generated IDs", () => {
  const result = excalidrawToMermaid([
    element("rectangle-1", "rectangle"),
    element("ellipse-1", "ellipse"),
    element("diamond-1", "diamond"),
  ]);

  assert.equal(
    result.mermaid,
    [
      "flowchart TD",
      '  n_64_69_61_6d_6f_6e_64_2d_31{"diamond-1"}',
      '  n_65_6c_6c_69_70_73_65_2d_31(["ellipse-1"])',
      '  n_72_65_63_74_61_6e_67_6c_65_2d_31["rectangle-1"]',
      "",
    ].join("\n"),
  );
  assert.deepEqual(result.warnings, []);
});

test("uses bound text for nodes and bound arrows and lines", () => {
  const result = excalidrawToMermaid([
    element("start", "rectangle"),
    element("end", "ellipse"),
    element("arrow", "arrow", {
      startBinding: { elementId: "start" },
      endBinding: { elementId: "end" },
      startArrowhead: null,
      endArrowhead: "arrow",
    }),
    element("line", "line", {
      startBinding: { elementId: "end" },
      endBinding: { elementId: "start" },
    }),
    element("start-label", "text", {
      containerId: "start",
      text: "Start",
      originalText: "Start",
    }),
    element("arrow-label", "text", {
      containerId: "arrow",
      text: "Continue",
      originalText: "Continue",
    }),
  ]);

  assert.match(result.mermaid, /n_73_74_61_72_74\["Start"\]/);
  assert.match(
    result.mermaid,
    /n_73_74_61_72_74 -->\|"Continue"\| n_65_6e_64/,
  );
  assert.match(result.mermaid, /n_65_6e_64 --- n_73_74_61_72_74/);
  assert.deepEqual(result.warnings, []);
});

test("derives connector direction from independent arrowheads", () => {
  const connectors = [
    element("end-only", "line", {
      startBinding: { elementId: "start" },
      endBinding: { elementId: "end" },
      startArrowhead: null,
      endArrowhead: "arrow",
    }),
    element("start-only", "line", {
      startBinding: { elementId: "start" },
      endBinding: { elementId: "end" },
      startArrowhead: "arrow",
      endArrowhead: null,
    }),
    element("both", "line", {
      startBinding: { elementId: "start" },
      endBinding: { elementId: "end" },
      startArrowhead: "arrow",
      endArrowhead: "arrow",
    }),
    element("neither", "arrow", {
      startBinding: { elementId: "start" },
      endBinding: { elementId: "end" },
      startArrowhead: null,
      endArrowhead: null,
    }),
  ];
  const result = excalidrawToMermaid([
    element("start", "rectangle"),
    element("end", "rectangle"),
    ...connectors,
  ]);

  assert.match(result.mermaid, /n_73_74_61_72_74 --> n_65_6e_64/);
  assert.match(result.mermaid, /n_65_6e_64 --> n_73_74_61_72_74/);
  assert.match(result.mermaid, /n_73_74_61_72_74 <--> n_65_6e_64/);
  assert.match(result.mermaid, /n_73_74_61_72_74 --- n_65_6e_64/);
  assert.deepEqual(result.warnings, []);
});

test("escapes Mermaid-sensitive labels while preserving UTF-8 text", () => {
  const result = excalidrawToMermaid([
    element("node", "diamond"),
    element("label", "text", {
      containerId: "node",
      text: "ignored wrapped text",
      originalText: 'A "quote" & <tag> \\ path\nCafé ✓',
    }),
  ]);

  assert.match(
    result.mermaid,
    /A &quot;quote&quot; &amp; &lt;tag&gt; &#92; path<br\/>Café ✓/,
  );
});

test("skips deleted, dangling, unbound, and unsupported elements with warnings", () => {
  const elements = [
    element("kept", "rectangle"),
    element("deleted", "ellipse", { isDeleted: true }),
    element("image", "image"),
    element("free", "freedraw"),
    element("unbound-text", "text", { containerId: null, text: "Loose" }),
    element("unbound-arrow", "arrow", {
      startBinding: null,
      endBinding: null,
    }),
    element("dangling-line", "line", {
      startBinding: { elementId: "kept" },
      endBinding: { elementId: "missing" },
    }),
    element("dangling-label", "text", {
      containerId: "dangling-line",
      text: "Lost label",
      originalText: "Lost label",
    }),
  ];
  const result = excalidrawToMermaid(elements);

  assert.doesNotMatch(result.mermaid, /deleted|image|free|arrow|line|Loose/);
  assert.deepEqual(result.warnings, [
    "2 unsupported element(s) skipped: freedraw (1), image (1).",
    "1 unbound text label(s) skipped.",
    "1 unbound connector(s) skipped.",
    "1 dangling connector(s) skipped.",
    "1 bound connector label(s) skipped with omitted connector(s).",
  ]);
  assert.equal(result.omittedCount, 6);
  assert.deepEqual(result, excalidrawToMermaid([...elements].reverse()));
});

test("produces deterministic output regardless of input order", () => {
  const elements = [
    element("z", "rectangle"),
    element("a", "ellipse"),
    element("connector", "arrow", {
      startBinding: { elementId: "a" },
      endBinding: { elementId: "z" },
    }),
    element("label-z", "text", {
      containerId: "z",
      text: "Z",
      originalText: "Z",
    }),
  ];

  assert.deepEqual(
    excalidrawToMermaid(elements),
    excalidrawToMermaid([...elements].reverse()),
  );
});
