# O7 server-bound worker contract gate — 2026-10-23

Base `2a6a9a783c57e002a16a92911285e64c76669a14` (-6) in an isolated worktree.

## Reused provenance work, not reimplemented

The confirmed broker-origin fix `0a3c3132` was absent from the -6 ancestry. It was reused verbatim through a local `cherry-pick -x` (`fe85a4da`) rather than rewritten. The local HTTP `/v1/workers/{ownerId}` and `/reports` endpoints are owner-scoped projections, NOT a platform-issued signed principal. `/reports` now carries broker-assigned `origin` from the earlier fix: `authenticated-worker-message` versus `broker-event`. The action endpoint forbids a client-supplied `from` or `origin`. Control API tokens authenticate the local caller, not the remote worker to Company. There is no independent signed proof bearing owner/run/worker/seat/epoch/TTL/revoke.

## New contract enforcement

O7 Company grant now additionally requires a nonempty broker-owned `conversationId` in the active worker status, matching the selected seat/ticket's ownerId, runId, workerId and label. The binding persists a copy of that conversation ID, and triage refuses changed/missing session IDs on subsequent server-side status reconciliation. Older grants lacking this field fail closed on triage; legacy policy still defaults to manual. This is a server-side identity/binding check, not cryptographic attestation of ChatGPT platform calls. The Company grant/revoke/epoch/TTL logic and meetings remain unchanged.

## Test evidence and limits

Focused Vitest 36/36 across company-autonomy, company-delegation, company-broker, control-api-workers. Existing API tests run the actual HTTP local server against temporary directories with an in-memory bound worker conversation and verify broker origin, report, persisted ACK replay, revocation and meeting rules. New test rejects an active worker without a server conversation ID and rejects a worker reassigned to a different conversation (even if owner/run/worker/label remain unchanged). No external ChatGPT worker, CEO account, real company chairs, real grants or secrets were used. Typecheck, build, Company Electron smoke, notices and privacy gates passed. The existing Company smoke uses a synthetic fixture, not a main window authenticated to CEO.

**Still blocked:** no externally signed/attested principal containing real ChatGPT account+conversation and worker run claims is available over the current plugin/HTTP contract. The session `conversationId` is server-owned state but can be attached by the browser runtime; this is stronger binding, not a signature independent from the runtime. End-to-end external worker authorization requires a genuinely isolated platform session and new signed proof/verification or trusted MCP caller attribution contract. Until then, no blanket CEO autonomous approval is claimed. Scope remains only `internal-triage`, with OS/service authorizations unaffected.

No Debian, install, push, main/tag/release or production profile accesses.
