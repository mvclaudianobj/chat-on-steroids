# Company of agents — visual prototype (Phase 1)

The Company sidebar screen presents the same local requests in a six-column board and a seven-area office, with CEO actions, token-budget progress, an activity feed and a meeting-room preview. All four screenshots were captured in isolated Electron with synthetic, explicitly labelled examples. The app itself starts with an **empty** company; the **Explore sample data** action opt-ins to synthetic content. Existing requests persist in `<userData>/company/company.json` via validated, main-frame-only IPC and atomic publication.

| View | Dark | Light |
| --- | --- | --- |
| Board | [Board dark](company-board-dark.png) | [Board light](company-board-light.png) |
| Office | [Office dark](company-office-dark.png) | [Office light](company-office-light.png) |

Run `npm run build` and `node scripts/verify-ui.mjs company` to recreate the screenshots in `.tmp/company-ui/`; run `npx vitest run test/company.test.ts` for the contract and persistence checks.

## Phase 2 (after visual approval)

Connect company requests to the existing agents/worker family owner, engine selectors and worktree identities. Record actual token/time use only from their authoritative sessions; stop using synthetic cost projections. Route status changes from real work events to this snapshot (single main-process owner), and enforce seat capacity at admission. Route meetings through a bounded shared thread; persist minutes and explicit decisions to Brain using its validated storage API. Deliver approval-required CEO escalations and digests through the Notifications Center, while risky actions still require a direct, auditable CEO approval. Tie actors to durable chats/sessions, keep an immutable decision history, and reconcile orphaned work after restart. Do not automatically execute company requests or send notifications during Phase 1.
