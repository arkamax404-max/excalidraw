import test from "node:test";
import assert from "node:assert/strict";
import { validUsername, sharePath, memberPath, memberNames, shareHint } from "./sharing.mjs";

test("only a diagram the user owns exposes sharing paths", () => {
  const owned = { kind: "file", id: "42", name: "one" };
  assert.equal(sharePath(owned), "/api/diagrams/42/members");
  assert.equal(memberPath(owned, "invitado"), "/api/diagrams/42/members/invitado");
  assert.equal(memberPath(owned, "a b/c"), "/api/diagrams/42/members/a%20b%2Fc");
  for (const identity of [null, undefined, { kind: "diagram", id: "42" }, { kind: "file" }]) {
    assert.equal(sharePath(identity), null);
    assert.equal(memberPath(identity, "invitado"), null);
  }
});

test("unavailable sharing explains itself instead of hiding or inventing authority", () => {
  assert.equal(shareHint({ kind: "file", id: "42", name: "one" }), null);
  for (const identity of [null, undefined, { kind: "diagram", id: "42" }, { kind: "file" }]) {
    assert.equal(shareHint(identity), "Carga un diagrama tuyo para compartirlo.");
  }
});

test("usernames follow the server rule before a request is sent", () => {
  for (const value of ["invitado", "a.b_c-1", "abc", "a".repeat(50)]) {
    assert.equal(validUsername(value), true, value);
  }
  for (const value of ["", "  ", "ab", "a".repeat(51), "a b", "a/b", "ñ", null, undefined, 42]) {
    assert.equal(validUsername(value), false, String(value));
  }
});

test("member names are read from the payload and stale junk is dropped", () => {
  assert.deepEqual(memberNames({ members: [{ username: "zoe" }, { username: "ana" }] }), ["ana", "zoe"]);
  assert.deepEqual(memberNames({
    members: [{ username: "ana" }, { username: "" }, { username: 7 }, {}, null, "suelto"],
  }), ["ana"]);
  for (const payload of [null, undefined, {}, { members: null }]) {
    assert.deepEqual(memberNames(payload), []);
  }
});
