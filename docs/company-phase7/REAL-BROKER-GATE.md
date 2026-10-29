# O7 real broker provenance gate — 2026-10-23

Base: integration `2be2af72`. Exclusive test worktree. No real CEO account, externally spawned ChatGPT worker, OS/service tool authorization, or Debian package was used.

## Actual capability and blocker

The existing control API `/v1/workers/{ownerId}/reports` returned `id,from,runId,time,text` but lacked a server-attested origin classification. The `from` field is assigned by broker logic, but both an authenticated worker-to-prime message and broker-generated completion report use the same worker ID. A prompt string alone is NOT sufficient proof of delegated authority. The external Chat Marks executions plugin's read-only `agents status` reported no workers owned by this caller. No real remote platform worker could be proven without an external spawn, which was not authorized. Thus the platform-worker end-to-end gate remains OPEN, not PASS.

## Functional hardening implemented

An `origin` marker is set only at `stageMessages` after `requireMember` resolves an authenticated worker conversation to its owner/run/worker binding; server-synthesized finish/health notices never receive it. The local control API reports `origin: authenticated-worker-message | broker-event`. Legacy records lack provenance and are treated as non-authoritative. O7 `internal-triage` requires the attested origin in addition to owner/run/worker, matching label/status, active TTL, epoch, timestamp, CEO grant and a pre-authorized scope. Once a decision commits, its specific report ID is stored in the bounded audit trail, allowing an exact replay after failed ACK to acknowledge safely without repeating the operation. No client-provided `origin` or `from` accepted by action endpoint.

## Evidence

The focused Vitest suite invokes the actual local loopback HTTP worker server with a randomly generated ephemeral token under a temporary directory, calls broker spawn and binds an in-memory synthetic conversation without launching ChatGPT, writes a worker-scoped message using `agents.sendMessage`, retrieves `/reports`, checks server-defined origin, persists Company ticket transition, reads and ACKs via the real endpoint, and verifies replay after a broker snapshot restore. It also demonstrates a forged `from` request is rejected, a foreign worker conversation cannot post a report, and a broker-generated `finish` with a matching-looking prompt string has `origin=broker-event` and cannot authorize O7. O7's other fixture tests cover expiry, revocation during asynchronous report lookup, persistence and audit, and meeting flows. This is real *local broker code and HTTP API with synthetic conversation binding*, NOT an independently authenticated live ChatGPT worker session; no production claim is made.

## Next required gate

To prove actual platform worker origin, an explicitly approved ephemeral external worker must be launched under isolated profile/owner and have the platform attest conversation and run identity. The plugin's `agents status` does not expose signed origin receipts, and no caller-owned worker existed in this conversation. Keep O7 delegated approval fail-closed on any legacy/unmarked report. Real-world CPU/release contention prohibited a heavy build/packaging run in this independent gate.
