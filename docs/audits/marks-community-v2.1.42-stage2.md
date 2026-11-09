# Auditoria Stage 2 — upstream v2.1.42 → Chat Marks 2.1.42.1

Data: 2026-10-19. Escopo: código integrado, recursos exclusivos Marks, dependências, configurações, Skills, packaging e CI. Esta auditoria é **evidência de fonte e testes locais em Linux**; não certifica instaladores Windows/macOS, assinatura Firefox, disponibilização pública nem atualização em cliente instalado.

## Identidades fixadas e método

| Papel | Commit imutável | Proveniência |
| --- | --- | --- |
| Baseline Marks anterior ao merge | `1f6408a03fd78ef7130cdb0e4ad54053e0a346ae` | Primeiro pai do merge `350ec677`, produto `2.1.41.1` |
| Release comunitária | `5456eb390bb9c4d54b7a3d076a5201ec5677f5e2` | Tag `v2.1.42`, segundo pai de `350ec677` |
| Merge comunitário | `350ec67735bf28ef72fb3252b81de4f96f8d9585` | Dois pais acima; integração Marks |
| Baseline atual do fork | `6a64f1518d523adb75304ad2d5e9e40c5cdf66d7` | `marks/main`, merge do PR #5 |
| Stage 1 auditada | `b42e44c73c9a856bd3900ff22ea21d8f8649dc80` | `feat/marks-release-21421-stage1`; inclui workflow de worker-1 e Skill de merge |

Trabalho realizado em worktree nova `.tmp/marks-release-21421-stage2`, branch `audit/marks-release-21421-stage2`, criada exatamente de Stage 1. **Nenhuma edição** da worktree compartilhada, `.tasks`, workflows de release, versão, tag, binários ou PR AI Hero. `git merge-base --is-ancestor v2.1.42 HEAD` retornou 0; ambos os pais de `350ec677` foram verificados com `git show -s --format='%P'`.

Comparar diretamente `baseline Marks..upstream` produz **308 arquivos, 4.537 linhas adicionadas e 14.800 removidas**: a maior parte das remoções são customizações exclusivas do fork presentes no baseline e ausentes do projeto comunitário. Este diff serve para localizar áreas a preservar, **não** como evidência de regressão do resultado. O comparativo correto `baseline Marks..Stage 1` tem **76 arquivos, 2.638 inserções e 142 remoções**, concentrados nas novas funcionalidades e no trabalho de integração. A diferença `marks/main..Stage 1` cobre apenas os scripts/testes/documentos da Skill e `.github/workflows/release.yml` + `test/marks-release-pipeline.test.ts` do worker-1.

## Matriz de novidades upstream — presença e prova

| Área | Novidade v2.1.42 e commit de origem | Evidência integrada e teste | Resultado / risco |
| --- | --- | --- | --- |
| Recall de mensagens | Navegação de histórico com ↑/↓ no composer, apenas prompts humanos; conserva caret, filtro, ordem e não traz mensagens automáticas. `cae3b68c`, `05041938`, `92547a52`, `62798b59`, `c43f3993` | `src/renderer/chat.ts` (`typedPrompt`, `sentPrompts`, `recallPrompt`, `composerInputsLoaded`), `src/main/session/automatic-replies.ts`, `src/shared/session.ts`; testes de renderer e Goal | **Incorporada**, separa autoria, trabalho pendente e replay; interação real de teclado Electron ainda necessária |
| Resposta nativa progressiva | Exibe blocos Markdown concluídos e segura listas, código, fórmulas e writing blocks até fronteira estável; correções de linhas finais e citações. `6bba087e`, `9b18d0cb`, `97b079cb`, `15082b66` | `src/renderer/chat.ts` (`finishedBlocks` e atualização de held), `test/renderer-timeline.test.ts`, `test/renderer-html.test.ts` | **Incorporada**; teste visual real ainda pendente |
| Continuação de turnos longos | Espera limitada pela efetiva entrega de mensagem de rotação antes de liberar resultado da ferramenta, mantendo identidade exata. `d4bc1f31` | `src/main/rotation-hold.ts`, `src/main/bridge.ts`, `src/main/session/input.ts`, `test/kernel-rotation-hold.test.ts`, `test/bridge-turn-rotation.test.ts` | **Incorporada**; cobertura de timeout e envio no teste de fronteira |
| Compaction & Resume | Informa motivo de tentativa automática adiada e novo estado `held`. `66ff11a9` | `extension/content.js` reporta `sourceDeferred`; `bridge.ts` conserva motivo por ticket; `src/shared/recovery.ts` e `renderer/recovery.ts` projetam estado; testes bridge/extension/recovery | **Incorporada**; recuperação real após suspensão MV3 exige browser |
| Electron/Firefox/worker | Reconhece add-on Firefox anterior por `moz-extension://` ou user-agent, e só oferece abertura de worker/tab ao companion autorizado. `b7728839`, `5bfa07f7`, `7df22d4a` | `src/main/bridge.ts` (`geckoExtension`, `takesWork`), `test/bridge.test.ts`, `test/extension.test.ts` | **Incorporada**; add-on assinado Firefox não foi exercitado |
| Diário MV3 | Agrupa observações durante escrita em um único próximo snapshot, evitando encadeamento redundante de gravações. `2aa6a753` | `extension/background.js` (`queuedJournalWrite`), `test/extension.test.ts` | **Incorporada**; latência de perfil/browser real não medida |
| Goal/Loop | Protege palavras literais, comandos, flags e trechos entre aspas contra normalização de erros de digitação; marca respostas automáticas para recall. `aa4f0774`, `92547a52` | `src/main/goal.ts`, `src/main/session/automatic-replies.ts`, `test/goal.test.ts`, `test/renderer-state.test.ts` | **Incorporada**; manter testes de falsos positivos |

## Matriz de preservação Marks

| Contrato exclusivo | Evidência de fonte e cobertura | Classificação |
| --- | --- | --- |
| Login obrigatório MarksPanel, validade não deslizante de 7 dias, proteção de CLI/IPC | `src/main/markspanel-auth.ts`, `src/main/index.ts`, `src/main/cli-modules.ts`, `test/markspanel-auth.test.ts` (35 testes), `test/marks-merge-preservation.test.ts` | **Preservado nos contratos testados**; login real no instalador não executado |
| MarksCode, MarksClaw, Codex, Claude; sessões/projetos/terminal | `src/main/cli-chat.ts`, `cli-modules.ts`, `src/renderer/workspace-terminal.ts`, `src/renderer/main.ts`; caminhos exclusivos não diferem do baseline; `marks-merge-preservation` e shell/renderer tests | **Preservado em fonte**; interações nativas pendentes |
| Skills, importação GitHub com SHA, Marks Agency | `src/main/skills.ts`, `src/main/marks-agency-agents.ts`, `src/renderer/skills-library.ts`, `test/skill-github.test.ts`, `test/skills-library-renderer.test.ts`, `test/marks-agency-agents.test.ts` | **Preservado**, origem/atualizações continuam no proprietário existente; PR AI Hero não faz parte desta branch |
| Branding, ícones e mascote Marks | `icon_marks.png`, `scripts/make-icon.mjs`, `src/main/window-icon.ts`, `electron-builder.yml`, `test/marks-icon.test.ts` | **Preservado em fonte**; instaladores não inspecionados |
| Updater somente do fork Marks | `src/main/update.ts` aponta para `mvclaudianobj/chat-on-steroids`, `src/main/version.ts` e `test/marks-release-pipeline.test.ts` | **Preservado em fonte**, requer prova de publicação/update E2E |
| Permissões/configurações existentes | `git diff 1f6408a03..HEAD -- src/main/config.ts src/shared/types.ts src/main/skills.ts` sem alterações; smoke de config/skills por testes adjacentes | **Sem mudança no owner**; não equivale a migração real de perfil |
| Histórico, Goal/Loop, outbox, worker identity | Merge em `bridge`, `goal`, `input`, `recorder`, `store`; testes `bridge`, `goal`, `extension`, `shell-compat` | **Mudança funcional combinada**, risco moderado até teste real em browser |

## Dependências, versões e distribuição

| Tema | Diferença verificada | Evidência / classificação |
| --- | --- | --- |
| Dependências npm | **Nenhum pacote incluído, retirado ou alterado de versão** no merge Marks `1f6408a03..350ec677`; o `package-lock.json` altera só `version` raiz e `packages[""] .version`: `2.1.41+1` → `2.1.42+1` (2 inserções/2 remoções) | `git diff -- package.json package-lock.json`; risco de ABI indireta do upstream **não demonstrado** |
| Identidade do produto | npm `2.1.42+1`; produto e extensão `2.1.42.1`; `electron-builder.yml` mantém `productName: Chat Marks`, `buildVersion: 2.1.42.1`, `buildNumber: '1'`, `extraMetadata.version: 2.1.42.1` | `node scripts/verify-release-version.mjs` **PASS**; sem mudança de appId |
| Windows/Linux/macOS | Manutenção dos destinos x64/arm64, NSIS, AppImage/DEB, DMG/ZIP, arquitetura e recursos nativos; testados apenas declaração, checksums e caminhos, não bytes de instaladores | `test/packaging.test.ts` (32 testes), `test/verify-release-assets.test.ts` (6), `test/marks-release-pipeline.test.ts` (3) |
| Verificação CI do merge | `350ec677` desloca suíte `verify:ci` pesada para arquitetura primária de cada SO e conserva typecheck/notices/version gate secundário; seis smokes continuam | `git diff 1f6408a03..350ec677 -- .github/workflows/release.yml` |
| Otimização adicional Stage 1 (worker-1) | `8838dabf` cria jobs `contracts` paralelos em Windows/macOS/Linux, cache de downloads Electron e verificação de metadata por arquitetura; `assemble.needs` inclui `contracts` | Teste `marks-release-pipeline` **PASS**; comportamento no GitHub Actions **não executado nesta auditoria**, e arquivo é propriedade do worker-1 |
| Integridade dos assets | `SHA256SUMS.txt` e versões/manifest de extensão têm verificador atual; a lista inclui alvos específicos da política da branch | `scripts/verify-release-assets.mjs`, testes adjacentes; **não** confundir checksum de arquivo com prova do SHA de build |

## Testes reproduzidos

Executados nesta **worktree isolada** sobre HEAD `b42e44c7` (código não modificado):

1. `npm run typecheck` — **PASS**.
2. `npm test -- --run test/marks-merge-preservation.test.ts test/marks-upstream-preflight.test.ts test/marks-release-pipeline.test.ts test/marks-icon.test.ts test/markspanel-auth.test.ts test/marks-agency-agents.test.ts test/skill-github.test.ts test/skills-library-renderer.test.ts test/packaging.test.ts test/verify-release-assets.test.ts test/verify-release-version.test.ts` — **10 arquivos / 111 testes PASS** (nome adicional de teste não existente é ignorado pelo Vitest e não conta).
3. `node scripts/verify-release-version.mjs` — **PASS**: release metadata para `v2.1.42.1`.
4. `git diff --check 1f6408a03..HEAD` — **PASS**.
5. Uma segunda execução extensa (`renderer-timeline`, `renderer-html`, `bridge`, `extension`, `content-script`, `bridge-turn-rotation`, `kernel-rotation-hold`, `goal`, `shell-compat`, `renderer-recovery`, `renderer-state`) foi **interrompida intencionalmente** pela concorrência de CPU com os testes de CI conduzidos por outros trabalhadores, mediante solicitação do prime. Antes da interrupção, o output mostrou individualmente verdes **8 arquivos / 1.422 testes**: `kernel-rotation-hold` (2), `goal` (145), `bridge-turn-rotation` (10), `extension` (342), `renderer-recovery` (21), `renderer-html` (52), `shell-compat` (136), `bridge` (714). **Não há resultado global / exit 0**, portanto não contar a segunda execução como uma suíte aprovada. `renderer-state` produziu avisos `ReferenceError: CSS is not defined` em jsdom; não houve evidência de falha da aplicação real nem resultado final da suíte. `renderer-timeline` e `content-script` ficaram sem confirmação final.
6. Teste serial mínimo pós-interrupção: `npm exec -- vitest run --maxWorkers=1 test/marks-merge-preservation.test.ts test/kernel-rotation-hold.test.ts` — **2 arquivos / 6 testes PASS, exit 0**. As suites pesadas não foram reiniciadas enquanto os outros jobs de CI estavam ativos.

## Matriz de riscos e pendências

| Severidade | Risco | Prova obtida | Próximo gate |
| --- | --- | --- | --- |
| Alta para publicação | Binários misturados de commits/runs diferentes apesar de mesma versão aparente | Tag upstream no histórico, commit Stage 1 fixo e comparação source-level; **nenhum pacote examinado** | Um único candidato no SHA/tag revisado, verificar metadados, SHA256SUMS e assets públicos; sem reutilizar outra origem |
| Alta para publicação | Quebra em Windows/macOS/Firefox não capturada em Linux | Apenas source e Vitest nesta máquina; teste nativo do SO e add-on assinado não executados | Jobs CI em cada OS, smoke GUI/instalado, Firefox real antes de declarar suporte |
| Média | Compaction/rotation sob atrasos e MV3 cold restart | Tests bridge/content/extension e owners novos; sem navegador vivo | Experimento com envio interrompido, reparo e retomada na mesma conversa/worker |
| Média | Regresso de tecla e anúncio acessível no recall | Tests de renderer, regras de caret/filtro/prime e exclusão de automação | UI Electron real com draft, attachments, menus e IME |
| Média | Cache e paralelismo CI do Stage 1 mudarem gating | Contratos fonte/teste passam, `assemble` depende do job `contracts` | Conferir run Actions no SHA final, falhas reais e tempo comparável; não alegar benchmark |
| Baixa a média | Config/Skills/MarksPanel não cobertos por upgrade real de userData | Owner não mudou e testes de unidade passaram | Testar update de instalação existente, login, Skills vinculadas, projetos e dados |

**Conclusão restrita:** a integração contém os commits relevantes do upstream e mantém os contratos principais Marks na fonte e nos testes focados executados. Não houve nesta auditoria regressão de produção reproduzida que justificasse alterar código; quaisquer falhas adicionais devem ser registradas com saída, reprodução e owner antes de corrigir. A aprovação de release depende dos gates nativos, artefatos e instalação separados.
