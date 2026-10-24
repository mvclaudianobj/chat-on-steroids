# QA: repeated ChatGPT host approvals vs. local durable grants (2026-10-24)

## Scope and evidence

Baseline `48223af059578ebf62fdf5bec366b4cbdee2a011`, separate `worker-13/qa-host-grants` worktree. All tests simulate cards/IPC in memory with disposable HOME/XDG paths. No real ChatGPT tab, account, CEO settings, production files, worker dispatch, installation, or host approval was touched.

Three separate decisions must remain distinguishable:

1. **ChatGPT's external tool approval card** is owned by ChatGPT. Chat Marks observes `data-codex-approval-surface`, forwards only `deny` and `allow` (= *Allow once*), and waits for the card to disappear. The `clicked` outcome alone is never confirmation. Chat Marks cannot issue the host's *Always allow* choice.
2. **ChatGPT Plugins permissions** (where the provider exposes them) are chosen in ChatGPT's Plugins settings. The app's setup describes *Allow all tools* in that provider UI. A local setting, including a Company/COO grant, cannot set or override it.
3. **Chat Marks internal durable grants**, once implemented, can govern only the locally attestable exact agent/action/scope. They must never suppress #1, issue #2, or create a worker/seat attestation from an unauthenticated broker.

## FAIL-FIRST reproduction

`test/approval-wait.test.ts` adds a two-card synthetic episode: card A asks permission for a local command, the person chooses `allow`, and the page reports `dismissed` after stable disappearance; 500 ms later, card B appears with the same words but a distinct `cardId`. The base `src/main/approval-wait.ts` treats B as a redraw of A if its text matches within `APPROVAL_GONE_MS` (4 s). The response is correctly cleared because the card ID changed; however, the second request reuses A's `progressId` and notice episode. The test expects B to have a fresh episode for explicit review, and **fails** on base `48223af0`:

```
expected 'approval-wait:chat:1000' not to be 'approval-wait:chat:1000'
```

Do not fix by automatically approving B or by reducing all redraw protection: existing tests prove that the *same still-unresolved* card can flicker for 1.2 s and must keep the prior episode. Distinguish a **confirmed dismissal** followed by a new card from that unresolved redraw. The page's `dismissed` signal confirms stable card removal, not permission for any future host call. A later `not_confirmed`/`clicked` event with a visible card still needs human attention.

`test/host-approval-policy-qa.test.ts` exercises actual `extension/chatgpt-dom.js` card parsing with simulated key-hint controls across all 12 localized renderer catalogs, checks that each catalog has the user-facing host-versus-plugin policy text, and verifies that an `always` answer never clicks the host's options menu. This test suite passed on the baseline before the FAIL-FIRST assertion was added.

## Integrator matrix after worker-3 and worker-12 patches

Run against a disposable `HOME`/`XDG_CONFIG_HOME`/`XDG_CACHE_HOME`; never use the CEO profile or the real browser:

| Test | Required observation |
| --- | --- |
| Host card A dismissed, B reappears same text <4 s | Distinct approval episodes; no reused previous consent, no automatic B click |
| A unresolved, card briefly flickers and returns | Same episode, no duplicated desktop notices |
| Host ignores Allow once click | `not_confirmed`, card stays waiting; never displayed as accepted |
| Card replaced between IPC request and delivery | Old token cannot affect replacement; `card_changed` reported |
| Host disables Allow once | Local Allow disabled; Deny still possible |
| Host options menu includes Always allow | Local app neither opens it nor claims the choice was granted |
| Internal one-task grant | Only the exact approved action and execution; no widening on replay or restart |
| Per-agent durable scope | Requires proven current agent identity + explicit scope; survives restart only until revocation/epoch invalidation |
| COO-wide local grant | Clear local scope and consequences; host/browser/OS approvals still independently enforced |
| Revocation, epoch, TTL, corrupt store | Immediate fail-closed, including stale in-flight results and idempotent replay |
| Three similar consent requests | May suggest widening only; **never** approves automatically |
| Broker without independent attestation | Cannot bind a Company seat or authorize external worker activity |
| 12 renderer locales | Distinguish `Allow once`, ChatGPT-only persistent choices and internal grants without claiming host control |

Focused commands in the QA worktree (existing dependencies can be reused read-only; do not run package/install):

```sh
HOME="$PWD/.qa-home" XDG_CONFIG_HOME="$PWD/.qa-config" XDG_CACHE_HOME="$PWD/.qa-cache" \
  ./node_modules/.bin/vitest run --maxWorkers=1 test/approval-wait.test.ts test/host-approval-policy-qa.test.ts
```

The baseline suite is intentionally red until its approval-episode defect is fixed. A green test-only run with that one test excluded is not evidence that durable internal grants have been implemented. E2E Electron main/preload/renderer, persist/restart, host delivery and revocation need to be reverified once the workers' implementation patches are actually integrated.
