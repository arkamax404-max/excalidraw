import assert from "node:assert/strict";
import test from "node:test";
import { toMermaidDownloadFilename } from "./mermaidFilename.js";

test("uses a normal server diagram name", () => {
  assert.equal(toMermaidDownloadFilename("release-plan"), "release-plan.mmd");
});

test("does not duplicate an existing Mermaid suffix", () => {
  assert.equal(toMermaidDownloadFilename("release-plan.mmd"), "release-plan.mmd");
  assert.equal(toMermaidDownloadFilename("release-plan.MMD.mmd"), "release-plan.mmd");
});

test("preserves meaningful Unicode", () => {
  assert.equal(
    toMermaidDownloadFilename("Planificación 東京"),
    "Planificación 東京.mmd",
  );
});

test("removes unsafe path and platform characters", () => {
  assert.equal(
    toMermaidDownloadFilename("../../Roadmap/Phase:1?"),
    "Roadmap-Phase-1.mmd",
  );
});

test("falls back for blank and invalid-only names", () => {
  assert.equal(toMermaidDownloadFilename("   "), "diagram.mmd");
  assert.equal(toMermaidDownloadFilename('<>:"/\\|?*'), "diagram.mmd");
  assert.equal(toMermaidDownloadFilename("CON"), "diagram.mmd");
});

test("uses the latest diagram name supplied on every call", () => {
  assert.equal(toMermaidDownloadFilename("diagrama-1"), "diagrama-1.mmd");
  assert.equal(toMermaidDownloadFilename("loaded-model"), "loaded-model.mmd");
});
