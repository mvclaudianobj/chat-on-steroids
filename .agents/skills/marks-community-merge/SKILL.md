---
name: marks-community-merge
description: Integra uma release/tag nova de totec448-spec/chat-on-steroids no fork Chat Marks sem perder MarksPanel, MarksCode, módulos, ícones, identidade, Skills nem mecanismos de atualização. Use ao pedir merge de versão da comunidade, atualização do fork, revisão de conflitos, preparação de release rápida ou proteção das melhorias exclusivas Marks.
---

# Chat Marks — merge comunitário rápido e seguro

## Contrato de início
- Ler `AGENTS.md`, o status e os diffs antes de editar. Preservar integralmente a árvore compartilhada, especialmente `.tasks/` e trabalho não commitado.
- Anotar o SHA exato de `marks/main` (**base Marks**) e da tag upstream (**base comunidade**); não confiar em nomes de branches móveis nem baixar tags que sobrescrevam tags do fork.
- Criar branch nova `integration/marks-community-X.Y.Z` partindo de `marks/main` atualizado. Nunca usar `reset --hard`, `git clean`, `git push --force` nem escolher `ours`/`theirs` globalmente.

## Integração
1. Fazer `git fetch marks main` e buscar só a tag solicitada, por exemplo
   `git fetch --no-tags upstream refs/tags/vX.Y.Z:refs/tags/community-vX.Y.Z`.
2. `git switch -c integration/marks-community-X.Y.Z marks/main`; `git merge --no-commit --no-ff community-vX.Y.Z`.
3. Resolver somente os conflitos listados por `git diff --name-only --diff-filter=U`: preservar ambos os lados sem reintroduzir bugs; mesclar catálogos de tradução por **chave**; nunca descartar ou duplicar integrações Marks silenciosamente.
4. Fixar revisão Marks `X.Y.Z.1`: `package.json` e lockfile recebem `X.Y.Z+1`; `APP_VERSION`, manifest da extensão e `electron-builder.yml` recebem `X.Y.Z.1`, com `buildNumber: '1'`.
5. Reunir novidades do upstream com What's New, CHANGELOG, traduções e `docs/release-notes/vX.Y.Z.1.md`. Links de release do Marks devem ir para `mvclaudianobj/chat-on-steroids`.

## Checklist obrigatório de preservação
- Login MarksPanel obrigatório, sete dias **desde a autenticação**, refresh sem prolongar o prazo; caminhos de IPC/MCP/CLI protegidos.
- Menu, sessões e terminais de projeto de MarksCode, MarksClaw, Codex e Claude, atalhos e branding Chat Marks.
- `icon_marks.png` como fonte de ícones NSIS, Linux, atalhos e janela em runtime; mascote Marks.
- Skills/Marks Agency, importação segura, fonte/proveniência de GitHub e alterações locais não afetadas.
- Updater, identidade do app e extensão, release assets e checksums coerentes com o commit real.
- Compatibilidade com recursos novos da comunidade; não remover código novo apenas porque difere do fork.

## Verificação em duas etapas, sem builds duplicados
1. **Gate rápido local:** `node scripts/verify-release-version.mjs`, `npm run typecheck`, `git diff --check`, testes focados nas áreas alteradas, `npm run build`. Se um falhar, corrigir **antes** do CI.
2. **Gate de distribuição (uma execução por commit/tag):** GitHub Actions para os sistemas não disponíveis localmente e smoke de instaladores específicos. Reutilizar candidatos apenas quando tag/commit/versão/checksums forem idênticos. Não rodar canary completo e publish completo duplicados por rotina.
3. Confirmar `git merge-base --is-ancestor <base-marks> HEAD` e `git merge-base --is-ancestor <tag-upstream> HEAD`. Inspecionar mudanças exclusivas e testar o comportamento, não apenas procurar arquivos.
4. Commit de merge com ambos os pais, push do branch e PR para `marks/main`; release/tag somente quando os requisitos da plataforma e o usuário autorizarem o lançamento. Nunca regravar releases já publicadas.

## Relatório final
Registrar SHA upstream, SHA Marks anterior, SHA merge, conflitos resolvidos, recursos preservados, testes realmente executados, bloqueios nativos e estado **separado** de código mesclado / tag / artefatos publicados / atualização detectável.
