# Chat Marks v2.1.42.1 — revisão final das Etapas 1–5

**Data:** 2026-10-19. **Escopo deste relatório:** a release estável `v2.1.42.1` **já publicada** e uma **PR distinta** com melhorias de velocidade/Skill. Não reutilizar a tag existente para novos binários: os commits desta PR são posteriores à tag imutável.

## Proveniência e estado

| Papel | SHA ou referência | Situação |
|---|---|---|
| Base exclusiva Marks pré-merge | `1f6408a03fd78ef7130cdb0e4ad54053e0a346ae` | ancestral do merge |
| Comunidade v2.1.42 | `5456eb390bb9c4d54b7a3d076a5201ec5677f5e2` | ancestral do merge |
| Merge explícito dos dois pais | `350ec67735bf28ef72fb3252b81de4f96f8d9585` | preservação auditada |
| `marks/main` e tag estável `v2.1.42.1` | `6a64f1518d523adb75304ad2d5e9e40c5cdf66d7` | release pública, não reescrever |
| Candidato de otimização/Skill | branch `review/marks-21421-release-automation` | separado, exige CI novo e revisão antes de merge/release |

A release pública [v2.1.42.1](https://github.com/mvclaudianobj/chat-on-steroids/releases/tag/v2.1.42.1) foi publicada em `2026-10-19T13:35:32Z` com 15 assets (Windows x64/arm64, Linux AppImage e DEB x64/arm64, macOS DMG e ZIP x64/arm64, Firefox, Chromium, fontes nativas, checksum e manifesto de update). O manifesto `SHA256SUMS.txt` contém 14 entradas, todas correspondentes a assets públicos; o único arquivo além do próprio manifesto fora dele é `firefox-updates.json`. Downloads públicos reais de `Chat-Marks-Extension.zip` e `Chat-Marks-Firefox.xpi` passaram em `sha256sum -c`. O workflow de publicação [39252109483](https://github.com/mvclaudianobj/chat-on-steroids/actions/runs/39252109483) encerrou **success** nos seis jobs nativos, assemble/publish/verify; a primeira tentativa teve falha HTTP 500 externa no macOS x64 e foi recuperada por rerun do mesmo SHA.

## Funcionalidades mantidas e novidades upstream

| Contrato | Evidência | Limite |
|---|---|---|
| Login obrigatório MarksPanel, expiração fixa em sete dias sem renovar prazo via token | fonte, 35 testes `markspanel-auth` | não foi realizado novo login real em conta do usuário |
| CLI/IPC/MCP com cercas de autorização; MarksCode, MarksClaw, Codex, Claude, terminal e projetos | diffs Stage 2 e testes de preservação | não foram exercitados todos os conectores externos ao vivo |
| Branding, `icon_marks.png` e ícones na janela/DEB/atalho; mascote Marks | `dpkg -V`, hash do ícone instalado, testes `window-icon`, Electron GUI Linux `pet-toggle` | macOS UI CI de `marks/main` ainda falha no teste do mascote |
| Skills, Marks Agency, importação GitHub e updater do fork | testes `skill-library`, `skills-library-renderer`, `user-skills`; `app-update.yml` aponta para o Marks | Skill nova ainda não faz parte do app v2.1.42.1 instalado |
| Upstream: recall de prompts, renderização progressiva, rotation/hold, Compact & Resume, Goal/Loop, journal MV3, Firefox | ancestry Git, matrizes Stage 2 e suítes direcionadas | E2E em navegadores reais e dados migrados não concluído |

Ver `marks-community-v2.1.42-stage2.md` e `marks-upstream-v2.1.42-stage2.md` para matrizes por arquivo/commit. A importação AI Hero permanece separada na PR #6; não integra a distribuição atual.

## Processo acelerado preparado (não publicado)

- A suíte completa de contratos roda em paralelo nos **três sistemas principais**: Windows x64, macOS arm64, Linux x64; seis builds nativos independentes executam em paralelo com smoke de cada arquitetura. `assemble.needs` obriga ambos os grupos, fontes nativas e plano a passar.
- Os alvos secundários Windows arm64, macOS x64 e Linux arm64 mantêm **typecheck, notices e verificação de versão**; uma regressão encontrada na revisão da Stage 3 foi corrigida antes de preparar esta PR.
- Cache de downloads Electron/electron-builder usa SO, arquitetura e hash do lockfile; não cacheia `node_modules` nem instaladores prontos.
- A Skill `marks-community-merge` em `.agents/skills/marks-community-merge/SKILL.md` é encontrada pela descoberta de Skills de projeto (`src/main/skill-library.ts`, fonte `repo-agents`). Inclui `merge-guard.mjs` com preflight SHA/checksums/recovery não destrutivo, `local-release.mjs` com modo dry-run por padrão e referências de comandos em `references/commands.md`. O modo package recusa `node_modules` simbólico (poderia produzir pacote sem `detect-libc`).

## Medições — distinguir ganhos medidos de esperados

| Cenário | Duração observada | Inferência válida |
|---|---:|---|
| Jobs macOS Intel anteriores (dois runs) | 46m36s / 48m23s | baseline de **job**, não da release inteira |
| Job macOS Intel v2.1.42.1, após remover suíte duplicada | 28m11s | redução observada ~39,5–41,8% **nesse job** |
| Empacotamento macOS Intel dentro do job novo | 22m56s | ainda gargalo; pacote mais lento que referências 17m23s / 20m28s |
| Publicação v2.1.42.1 somando tentativa falha, intervalo e rerun | 69m45s | não atribuir a lentidão inteira ao runner; HTTP 500 e intervalo entre tentativas |
| Tentativa 2 da publicação | 33m12s | reutilizou jobs aprovados; não é build limpo integral |
| Ensaio Linux x64 local aprovado, AppImage+DEB+smoke | 1m58,61s | sucesso em **um host Linux** com dependências isoladas |
| Primeiro ensaio Linux incorreto (`node_modules` link) | 3m54,06s, FAIL | não representa benchmark de build válido |

A pipeline paralela **nova** ainda **não foi executada em runners de CI**: ganho de tempo total e taxa de cache hit são **pendentes**, não supostos. Detalhes de horários estão em `marks-release-21421-stage3-actions-timings.md` e `marks-release-21421-stage3-local-validation.md`.

## Testes e limites

- **Final desta PR (Linux):** `git diff --check`, `verify-release-version`, `npm run typecheck`, `npm run verify:notices` (730 sources), `npm run verify:privacy` (histórico público), Vitest 90/90 focados de auth, branding, packaging, release e guard, e 21/21 de Skills. A validação `actionlint` das mudanças de workflow foi **aprovada em uma worktree anterior**; não estava disponível na worktree final para repetição. `npm audit`: 14 alertas (8 moderados, 6 altos), não introduzidos comprovadamente por esta PR, requerem triagem.
- **Etapa 4:** DEB v2.1.42.1 instalado, aplicativo em execução X11, `dpkg -V` limpo, `app.asar` e dependências nativas presentes, 65/65 testes correspondentes, GUI Electron isolada Linux `whats-new` e `pet-toggle` PASS. Dados do usuário não foram alterados.
- **Limites não dispensados:** CI da PR nova; E2E da instalação Windows/macOS fora dos runners; upgrade do usuário desde versão anterior com migração de perfil; testes de navegadores/contas externas; CI UI macOS falhou no `verify-pet-toggle.cjs` no run `39251941147`. Correção de fixture existente permanece *dirty* na árvore compartilhada e **não faz parte desta PR**; sua validação macOS real continua pendente. A suíte integral de ~9,7 mil testes não foi repetida integralmente sobre estes commits finais; etapas anteriores a executaram antes das mudanças da Skill/workflow.

## Uso mínimo e rollback

```sh
# Em uma nova worktree, com a revisão aprovada e sem alterações pendentes:
npm ci --prefer-offline
HEAD_SHA=$(git rev-parse HEAD)
node .agents/skills/marks-community-merge/scripts/local-release.mjs --head "$HEAD_SHA" --level check --test test/marks-merge-preservation.test.ts --execute yes
node .agents/skills/marks-community-merge/scripts/local-release.mjs --head "$HEAD_SHA" --level package --platform linux --arch x64 --execute yes
node scripts/smoke-packaged-runtime.mjs --platform linux --arch x64
```

Em uma próxima comunidade, usar `merge-guard.mjs preflight` depois de baixar **somente** tag upstream escolhida e criar worktree nova; revisar cada conflito e ancestry. Se falhar, `merge-guard.mjs recovery --record <preflight.json> --destination <nova-worktree> --branch recovery/<versão>` (simulação por padrão); nunca apagar worktree problemática nem fazer reset forçado na principal. Se um runner transitório falhar, preferir rerun seletivo do mesmo SHA; se for necessário mudar código após tag, criar revisão superior (por exemplo `v2.1.42.2`) com metadata consistente. **Nunca mover a tag `v2.1.42.1` nem anexar binários de outro commit a ela**.

## Decisão de publicação

Estas melhorias ficam apenas em **PR de revisão**, sem merge automático nem tag/release nova. Se aprovadas, validar a PR e o novo workflow nativo primeiro, depois versionar uma revisão superior antes de emitir instaladores. A tag pública atual e sua instalação devem permanecer intactas.
