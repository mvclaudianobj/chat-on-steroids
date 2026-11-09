# Company of agents — visual prototype (Phase 1)

The Company sidebar screen presents the same local requests in a six-column board and a seven-area office, with CEO actions, token-budget progress, an activity feed and a meeting-room preview. All four screenshots were captured in isolated Electron with synthetic, explicitly labelled examples. The app itself starts with an **empty** company; the **Explore sample data** action opt-ins to synthetic content. Existing requests persist in `<userData>/company/company.json` via validated, main-frame-only IPC and atomic publication.

| View | Dark | Light |
| --- | --- | --- |
| Board | [Board dark](company-board-dark.png) | [Board light](company-board-light.png) |
| Office | [Office dark](company-office-dark.png) | [Office light](company-office-light.png) |

Run `npm run build` and `node scripts/verify-ui.mjs company` to recreate the screenshots in `.tmp/company-ui/`; run `npx vitest run test/company.test.ts` for the contract and persistence checks.

## Phase 2 (after visual approval)

Connect company requests to the existing agents/worker family owner, engine selectors and worktree identities. Record actual token/time use only from their authoritative sessions; stop using synthetic cost projections. Route status changes from real work events to this snapshot (single main-process owner), and enforce seat capacity at admission. Route meetings through a bounded shared thread; persist minutes and explicit decisions to Brain using its validated storage API. Deliver approval-required CEO escalations and digests through the Notifications Center, while risky actions still require a direct, auditable CEO approval. Tie actors to durable chats/sessions, keep an immutable decision history, and reconcile orphaned work after restart. Do not automatically execute company requests or send notifications during Phase 1.


## Phase 2 incremental pilot (local branch)

Company seats are individually assigned by the CEO/COO from `marks1..marks10` for new configurations. A previously stored 11–99 seat organization remains readable and writable without automatic truncation; reducing it while a removed seat has tickets is refused. An assigned ticket cannot change into Working without a matching execution admission, and Done cannot be entered before a verified report. Legacy board examples remain labelled as synthetic and do not imply a worker is running.

`CompanyRequest.execution` is the durable binding tuple `{ownerId, runId, workerId, authorizedAt}` with phase, report ID and evidence. A ticket may be completed only after its bound broker worker reports, its recorded evidence is inspected, and it is reviewed. IPC intentionally refuses `authorize` / `report` / `attendance` until broker-side binding validation is implemented; no live dispatch is claimed. Store-level tests simulate the exact transitions and reject another worker's report, duplicate outcome, and silent substitution. The real broker exposes `POST /v1/workers/{ownerId}/spawn` (returns `worker-N`, tied to an owner/run), `POST .../message`, `GET .../reports` and `POST .../ack`, all gated by control API actions and multi-agent settings. It does **not** expose a seat-to-worker stable mapping or per-seat signed acknowledgement. `POST /v1/inputs` only admits an outbox row; it is not proof of delivery or task completion. The remaining dependency is a main-owned correlation adapter with durable worker receipts, explicit model/owner consent, validated project/workspace and tool limits, and report deduplication, preferably using direct agent broker functions rather than loopback HTTP secrets.

Meetings now offer **Meeting → Send invitations** in the Company page, creating invited records for every configured seat. Invitation is not presence. Acceptance and attendance require separate evidence in the contract, followed by a contribution, minutes and decisions. The `BrainSync` marker remains `pending`; no Brain writes or Notifications deliveries are performed. IPC refuses attendance updates until a trustworthy worker acknowledgement pathway exists. This is a useful local planning pilot and an operational contract with a tested simulated flow, rather than a claim of live orchestration.
