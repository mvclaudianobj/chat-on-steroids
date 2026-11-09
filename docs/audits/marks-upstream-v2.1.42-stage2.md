# Auditoria Stage 2 — Marks × upstream v2.1.42

Auditoria de **código e testes focados** da worktree isolada `audit/marks-release-21421-stage2-worker1`. Não é evidência de pacote instalado nem de execução real em Windows/macOS. Nenhuma atualização de versão, tag ou publicação faz parte desta auditoria.

## Proveniência reproduzível

| Papel | Ref e SHA |
| --- | --- |
| Marks anterior à integração | `1f6408a03fd78ef7130cdb0e4ad54053e0a346ae` |
| Upstream oficial | tag `v2.1.42` → `5456eb390bb9c4d54b7a3d076a5201ec5677f5e2` |
| Ancestral comum | `8dfb808c871bb4d37431d10826a5b1230ce06632` |
| Merge comunitário integrado | `350ec67735bf28ef72fb3252b81de4f96f8d9585` |
| Marks `main` usado pelo stage 1 | `6a64f1518d523adb75304ad2d5e9e40c5cdf66d7` |
| Stage 1 auditado | `b42e44c73c9a856bd3900ff22ea21d8f8649dc80` |

`git merge-base --is-ancestor v2.1.42 HEAD` e `git merge-base --is-ancestor 1f6408a0 HEAD` retornaram **0**. Logo, o stage 1 contém ambos os históricos. Isso atesta ancestralidade, não substitui as verificações de comportamento abaixo.

## Matriz de preservação

| Área | Evidência de arquivos/diff | Testes focados e conclusão |
| --- | --- | --- |
| **Identidade Marks** | `git diff 1f6408a0..HEAD -- electron-builder.yml src/main/version.ts extension/manifest.json` mostra **somente** incremento `2.1.41.1` → `2.1.42.1`; `electron-builder.yml` retém `productName: Chat Marks`, nomes `Chat-Marks-*`, atalho `Chat Marks`; `src/main/index.ts` conserva título/janela/tray Marks; `src/main/version.ts` fixa o fork. | `test/marks-merge-preservation.test.ts` (4/4), `test/renderer-html.test.ts` (52/52) e `node scripts/verify-release-version.mjs --package-only` passaram. **Preservada no código**, sem teste de instalador nesta etapa. |
| **Login de sete dias** | `git diff --exit-code 1f6408a0 HEAD -- src/main/markspanel-auth.ts src/main/index.ts` sem alterações. `markspanel-auth.ts:11,113-127` mantém `SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000` e `authenticatedAt: previous?.authenticatedAt ?? Date.now()` (refresh não renova o login). `src/main/index.ts:461-499` exige autorização antes de iniciar o workspace, com monitor posterior. | `test/markspanel-auth.test.ts` (35/35), `test/markspanel-login-renderer.test.ts` (4/4). **Preservado nos testes de admissão, expiração e revogação**; sem conexão real ao serviço MarksPanel. |
| **Ícones Linux/Windows/macOS** | `git diff --exit-code 1f6408a0 HEAD -- icon_marks.png scripts/make-icon.mjs src/main/window-icon.ts` sem alterações; `git ls-tree` confirma o blob `151d8b920df0d84fc78c7673f634084ea40f99b7` para `icon_marks.png` nas duas versões. `scripts/make-icon.mjs:25,309-311` produz `build/icon.ico`, `build/icon.png` e `build/runtime-icon.png`; `electron-builder.yml:80-103,122,162,175-176` configura empacotamento; `src/main/index.ts:166,200` define ícone nativo. | `test/marks-icon.test.ts` (2/2), `test/window-icon.test.ts` (6/6). **Preservado na fonte**; não prova barras de tarefas em sistemas instalados. |
| **CLI e IPC** | `git diff --exit-code 1f6408a0 HEAD -- src/main/cli-modules.ts src/main/cli-chat.ts src/main/ipc.ts src/preload/index.ts` sem alterações. `src/main/ipc.ts:3-5,606-648` mantém os registradores CLI e bloqueio durante logout; `src/preload/index.ts:127-146` preserva `marksCli:request`, `cliChat:request`, `markspanel:logout`, sessões e eventos. | `test/cli-modules.test.ts` (6/6), `test/cli-chat.test.ts` (3/3), `test/cli-chat-protocol.test.ts` (4/4), `test/cli-chat-ui.test.ts` (2/2), `test/ipc.test.ts` (141/141). **Preservado nos contratos**; não equivale a executar Markscode/Marksclaw em hosts externos. |
| **Atualizador** | `git diff --exit-code 1f6408a0 HEAD -- src/main/update.ts` sem alterações. `src/main/update.ts:51` aponta apenas `mvclaudianobj/chat-on-steroids`; `src/main/version.ts:21-22` constrói a URL da extensão desse fork. `electron-builder.yml` mantém os nomes compatíveis com os assets Marks. | `test/update.test.ts` (65/65), `test/update-all.test.ts` (21/21) e verificação de versão passaram. **Preservado nos testes**; nenhum download/instalação remoto realizado. |
| **Interfaces e traduções** | `git diff 1f6408a0..HEAD -- src/renderer/index.html src/renderer/chat.ts src/renderer/styles.css src/renderer/whats-new.ts` mostra os acréscimos upstream para recuperar mensagem anterior (`#recallAnnounce`), entrada progressiva e notas `2.1.42.1`; os arquivos exclusivos `src/renderer/marks-modules-ui.ts`, `src/renderer/marks-agency-skills.ts` e `src/renderer/markspanel-login.ts` seguem presentes no fork (`git diff v2.1.42..HEAD --` mostra adições Marks). | `test/renderer-html.test.ts` (52/52), `test/renderer-i18n-source.test.ts` (9/9), `test/whats-new.test.ts` (7/7), `test/marks-merge-preservation.test.ts` (4/4) passaram. **Preservação comprovada no código e testes**; inspeção gráfica instalada não executada. |

## Novidades relevantes do upstream efetivamente presentes

`git diff --name-status 8dfb808c..v2.1.42 -- src/main/bridge.ts src/main/rotation-hold.ts src/main/session/automatic-replies.ts src/main/session/input.ts src/renderer/chat.ts src/renderer/index.html` mostra alterações em `bridge.ts`, `input.ts`, `chat.ts`, `index.html` e os novos `rotation-hold.ts`/`automatic-replies.ts`. Todos estão no stage 1; `git diff 1f6408a0..HEAD --` confirma sua incorporação. `test/bridge-turn-rotation.test.ts`, `test/kernel-rotation-hold.test.ts` e `test/turn-rotation.test.ts` exercitam a continuação de turnos; `test/renderer-shortcuts.test.ts` e testes do renderer cobrem partes das interfaces. Novas traduções aparecem em `extension/_locales/*/messages.json` e `src/renderer/locales/*.json`.

## Reprodução de verificações

Execute a partir da worktree auditada, com `npm ci --prefer-offline --no-fund` para instalar dependências. Os comandos Git seguintes são somente leitura:

```sh
git merge-base --is-ancestor v2.1.42 HEAD
git merge-base --is-ancestor 1f6408a0 HEAD
git diff --exit-code 1f6408a0 HEAD -- src/main/markspanel-auth.ts src/main/index.ts src/main/cli-modules.ts src/main/cli-chat.ts src/main/ipc.ts src/preload/index.ts src/main/update.ts icon_marks.png scripts/make-icon.mjs src/main/window-icon.ts
git diff 1f6408a0..HEAD -- electron-builder.yml src/main/version.ts extension/manifest.json
git diff 1f6408a0..HEAD -- src/renderer/index.html src/renderer/chat.ts src/renderer/styles.css src/renderer/whats-new.ts
git diff --name-status 8dfb808c..v2.1.42 -- src/main/bridge.ts src/main/rotation-hold.ts src/main/session/automatic-replies.ts src/main/session/input.ts src/renderer/chat.ts
```

Execução focada inicial: **17 arquivos de teste, 368 testes aprovados** (Vitest `--maxWorkers=2`), cobrindo login, marca, ícones, CLI/IPC, updater, interfaces, preflight e guardas de merge. `npm run typecheck`, `node scripts/verify-release-version.mjs --package-only` e `git diff --check` concluíram sem erros.

Uma rodada complementar confirmou **6 arquivos** adicionais: `bridge-turn-rotation` (10), `kernel-rotation-hold` (2), `turn-rotation` (5), `renderer-shortcuts` (2), `renderer-recovery` (21) e `renderer-i18n` (73), **113 testes com status de aprovação nos logs**. O sétimo arquivo, `renderer-timeline.test.ts`, não encerrou após mais de dois minutos; interrompi somente essa execução complementar para não manter o processo preso. **A rodada complementar como um todo não foi aprovada**, e `renderer-timeline` fica sem veredito nesta auditoria. Os 368 testes da primeira execução terminaram normalmente.

## Limites e decisão

Nenhuma regressão exclusiva Marks foi **reproduzida** nos contratos e testes focados concluídos, portanto nenhum arquivo de produção foi alterado nesta etapa. `renderer-timeline` segue **não verificado**, sem tratar sua ausência de resultado como aprovação. Não inferir aprovação de pacote/GUI Windows/macOS, login externo, atualização baixada, extensão Firefox ao vivo ou release publicada a partir destes resultados. O repositório principal com alterações locais, `.tasks` e `.tmp/aihero` permaneceram fora do trabalho.
