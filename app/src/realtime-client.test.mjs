import test from "node:test";
import assert from "node:assert/strict";
import { mayApplyScene, closeDecision } from "./realtime-client.mjs";

const scene = { type: "scene", payload: { elements: [] } };

test("scene applies only when there are no unsaved local changes", async () => {
  const { mayApplyScene: decide } = await import("./realtime-client.mjs");
  assert.equal(decide(scene, false), true);
  assert.equal(decide(scene, true), false);
});

test("non-scene and malformed frames never apply", () => {
  for (const frame of [null, {}, { type: "pointer", payload: {} },
    { type: "scene" }, { type: "scene", payload: { elements: {} } },
    { type: "scene", payload: { elements: [] }, unexpected: {} }]) {
    assert.equal(mayApplyScene(frame, false), false);
  }
  assert.equal(mayApplyScene({ ...scene, sender: { userId: "2" } }, false), true);
});

test("authorization failures stop permanently even before the retry", () => {
  for (const code of [1008, 401, 403, 404]) {
    for (const reconnects of [0, 1]) {
      assert.equal(closeDecision(code, reconnects), "authorization_failed");
    }
  }
});

test("other closes allow exactly one reconnect without resetting on success", () => {
  for (const code of [1000, 1006, 1011, 1013]) {
    assert.equal(closeDecision(code, 0), "reconnect");
    assert.equal(closeDecision(code, 1), "stop");
    assert.equal(closeDecision(code, 2), "stop");
  }
});
