# O4 - Company integration into QR+SMTP homologation

The base is a33a8b02 (homolog/marks-21452-qr-smtp-local-20261023). Company phase 1 bdc7b359 is already an ancestor and its existing sources were retained. Phase 2 and 3 were integrated in order: 6b031a7a, 36de1433, 788d219d and 2269a264. Translation catalog conflicts were merged by JSON key, preserving pre-existing homologation translations and adding missing Company keys. QR/SMTP/notifications, Brain, Skills and other unrelated base files were retained.

The integrated UI includes Company board, Office with rest lounge, explicit seat assignment, broker admission with native human confirmation, broker report review and meetings. The broker remains a real code path but no actual ChatGPT worker was launched during QA. Meeting invitations are not presence evidence; the fake-broker tests inspect owner/run/worker binding, stale reports and completion review. New configurations support 1..10 seats; saved legacy organizations above ten remain readable without automatic truncation. Hard worker token/time enforcement and cryptographic COO identity remain separate work.

Synthetic Electron captures are generated in `.tmp/company-ui/` by `node scripts/verify-ui.mjs company`. Notifications QA uses `node scripts/verify-ui.mjs notification`. None of these commands reads the installed profile or credentials.

Gates run at integration: `npm run typecheck`, `npm run build`, `npm run verify:privacy`, `npm run verify:notices`, 507 focused tests over 15 suites + 30 additional targeted tests, 2 Electron smoke checks (Company and Notifications). Logs are preserved outside the repository in `/tmp/o4-*.log`. No .deb build, installation, worker spawn, push, shared-branch merge or release.
