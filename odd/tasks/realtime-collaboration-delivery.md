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

Final API suite on the delivered content: 510 tests, 510 pass, 0 fail, exit 0.

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

- Delivery strategy for this long-lived branch is undecided: one pull request, or chained review slices.
- T5, T6 and T7 remain pending.
