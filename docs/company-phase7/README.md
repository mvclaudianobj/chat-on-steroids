# O7 — verified, limited Company autonomy

O7 starts at the committed O6 baseline `72b7fc977647803719f957a69fc3052dfe0f7899`. This implementation is additive and keeps Company Board, Office, CEO, RPG, and ad-hoc/emergency/daily/weekly meetings operational. No external tools or browser/OS authorizations are approved by O7.

## CEO-owned delegation

Manual remains the default, including snapshots from O1-O6. The CEO explicitly selects the configured `marks1..marksN` seat and a designation (director, manager, coordinator) and approves the grant in Electron's native confirmation dialog. Grant requires an **active unique broker-bound worker** previously admitted for the exact seat and ticket. Its authority is bound in durable state to `ownerId`, `runId`, `workerId`, exact worker label, grant epoch and a five-minute TTL. Audit stores who was selected, the selected designation, identity tuple, timestamp, scope, and decision IDs. Revocation clears authority, increments epoch and persists the previous identity tuple in the revocation audit event.

Workers cannot elect themselves, enlarge scopes or grant permission over renderer IPC. Only the CEO-controlled native-dialog operation can grant/revoke. Existing `marks-coo` role-only O6 configuration remains compatible but its unbound `ticket-review` approval is fail-closed until independent role authentication exists. Selecting a CEO-designated person through a real broker-bound worker is distinct from trusting that person by a role string or a renderer boolean.

## Exactly one automatic internal decision

The implemented autonomous scope is **`internal-triage` only**. With a live delegation and active broker session, a worker-origin server-managed report of exactly `COMPANY_TRIAGE:<requestId>:assigned:<seat>` can move an unassigned inbox request to a configured, available seat. This is a queue/assignment approval only. It **does not** spawn a worker, finish a ticket, send messages, activate tools, publish content, spend funds, grant OS permissions or satisfy independent service consent. Broker status and owner/run/worker/label are checked before fetching reports; event sender and run must match; final durable mutation rechecks epoch, session binding, TTL, timestamp, target state and seat availability. An existing decision cannot be applied again. Receipt acknowledgement follows persistence. Revocation while the broker request is in flight prevents the state transition.

The main process consumes these decisions when Company UI refreshes and via an explicit "Sync verified internal decisions" control. **No autonomous background daemon or wake timer** is claimed. A live worker must explicitly report a matching decision. This is automatic approval of eligible *received* proposals, not speculative work generation or continuous scheduling. Workers are never started by viewing the Company page.

## Coverage and known gaps

Focused Vitest tests use isolated temporary stores and a fake backend returning realistic server-shaped owner/run/worker/status/reports. They exercise selection, unauthorized role and forged renderer input, expiry, malformed/spoofed worker report, restart persistence, deliberate role titles, one-shot approvals and revocation during an in-flight broker call. Electron Company and Notifications UI smoke verify the renderer fixture and general screens. This is not a live worker-session or real CEO-account test. The worker message provenance and role/title semantics should be validated against a real disposable broker sandbox before claiming complete production autonomy. A dedicated background scheduler, if desired, would require a separate resource/consent design; O7 intentionally has none. Other catalog translations use English fallback except pt-BR, which is localized.

No `.deb`, installation, publishing, tags, merges or pushes are part of O7.
