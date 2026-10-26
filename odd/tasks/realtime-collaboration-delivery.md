# Realtime collaboration delivery record

Branch `excalidraw-ex`. Base for the retirement work: `4597a64` (`fix: fence realtime admission with locked authorization`).
This record only describes what was delivered and how it was proven; `odd/tasks/collaborative-diagrams.md` stays as the historical, unmodified record.

## Delivered slices (retirement of stale transports)

| Slice | Commit | Behaviour | Evidence |
| --- | --- | --- | --- |
| Member | `ed4413f` | Revoking a member closes that member's transports for that diagram only | RED 505 pass/1 fail with production untouched; GREEN 506/506; independent verifier PASS |
| Diagram | `fa2e00e` | Deleting a diagram closes its transports after the row delete and before backup cleanup | RED 506 pass/2 fail; GREEN 508/508; independent verifier PASS |
| Account | `f1ce7f5` | Deleting an account closes only the transports of its own diagrams, before directory cleanup | RED 508 pass/2 fail; GREEN 510/510; independent verifier PASS |
| Integration | — | Range `4597a64..f1ce7f5` reviewed as a whole | Independent verifier PASS on scope, ordering, shared machinery and existing contracts |

Final API suite on the delivered content: 510 tests, 510 pass, 0 fail, exit 0, re-run after the editor slices below.

## Editor and transport slices

| Slice | Commit | Behaviour | Evidence |
| --- | --- | --- | --- |
| Conflict reconciliation | `5804272` | Loading a server version after a save conflict applies only while the document state and generation are unchanged; otherwise the local canvas is kept and the user is told | Unit 16/16; independent verifier PASS after the generation-in-place case was added |
| Realtime client | `123fce3` | Opens the diagram socket after load/save, publishes only persisted scenes, applies inbound scenes only without unsaved local changes, one reconnect, permanent stop on authorization failure | Unit 20/20; verifier PASS S1/S2, S3 blocked by evidence (no intermediate snapshot) |
| Pointers and images | `d0b4dc5` | Coalesced pointer frames with a final up, remote cursors expiring after five seconds, image frames sent once and ingested additively | Unit 28/28; verifier PASS S1-S4, no findings |

Presence is derived from received pointers; the relay only accepts `sync_request`, `scene`, `pointer` and `files`, so no presence frame was invented.

Still unproven for these slices: browser and socket lifecycle against real peers. The API suite covers server and HTTP behaviour, not two browsers at once.

Executor prerequisite for controlled API runs lives on branch `feat/controlled-api-executor`, commit `5581b7e`, with a native review approved and its authority burned. It is not part of this branch.

## Slice boundary

- Retirement work is closed: member, diagram and account retirement plus integrated verification.
- Next behaviour work starts a new slice: editor reconciliation (T5), interface/images/reconnect (T6), final verification and documentation (T7).
- Any new commit after this document belongs to a later slice and must not be mixed with the retirement slices above.

## Delivery constraints observed

- No push, no pull request, no merge, no deployment.
- API executions: 9 of the 10 authorised runs were used, one left unspent; no retries.
- Two pre-existing realtime matrix cases stopped sending from a transport that retirement already closes. That is a consequence of the approved behaviour, not a weakened assertion.

## Open items

- Delivery strategy decided: one pull request, published as PR #1 against `main`. Merging remains a human decision.
- Browser-level collaboration between two real clients has not been exercised end to end.
- A browser harness is available as `npm run test:browser` (`app/scripts/test-browser.sh`, isolated image with Chromium, disposable PostgreSQL, two seeded users). It was proven to build, serve and authenticate, but the two-client scenario still fails while seeding a diagram through the API and then expecting it in the file list, so that test is not part of this delivery until it has evidence.
- Scene changes propagate live, not only on save: the client publishes the local elements inside a 250 ms window, never echoes a scene it just applied, and the receiver still refuses a remote scene while it has local unsaved changes. The browser scenario draws an unsaved element and requires it in the peer's canvas within two seconds (`t7f-live-1`, 1 passed, exit 0).
- Sharing has an owner-only control in the storage panel: a username field, a share button, a list of who has access with a revoke action, and it stays hidden for a diagram the user does not own. `share-diagram.mjs` proves it in a browser (`t7e-share-1`, 1 passed, exit 0): the owner shares a loaded diagram from the panel, the member sees it flagged as shared, cannot delete it and is not offered sharing.
- Member access is delivered in the editor: `documentTarget` routes a shared diagram to the id endpoints, the file list merges the two listings, deletion is not offered for a diagram the user does not own, and a save that would rename someone else's diagram is refused with its own message instead of sending a request without `If-Match`. The browser scenario `app/tests/browser/realtime-collaboration.mjs` now passes (`t7d-shared-3`, 1 passed, exit 0): a deletion saved by the owner reaches the member's already-open canvas in under two seconds without a reload, an unrelated diagram is untouched and neither page raises an error.
- Remaining limitation: the listing merge compares names, so a diagram shared with a user under a name they also own stays hidden. Fixing it needs an owner field in the diagram payload plus an API suite run.
- Still unproven: browsers other than Chromium, and the member writing while the owner is connected.
