---
name: marks-community-merge
description: Integra versões/tag do repositório comunitário totec448-spec/chat-on-steroids ao fork Chat Marks com preflight de SHAs, comparação de checksums, recuperação não destrutiva e preparação de release local. Use para merge comunitário, auditoria de conflitos, verificação de preservação MarksPanel/MarksCode/Skills, validação de pacotes e entrega segura de atualização.
---

# Chat Marks — merge comunitário rápido e seguro

## Contrato de início
- Ler `AGENTS.md`, o status e os diffs antes de editar. Preservar integralmente a árvore compartilhada, especialmente `.tasks/` e trabalho não commitado.
- Anotar o SHA exato de `marks/main` (**base Marks**) e da tag upstream (**base comunidade**); não confiar em nomes de branches móveis nem baixar tags que sobrescrevam tags do fork.
- Criar uma **worktree vinculada nova**, com branch `integration/marks-community-X.Y.Z` partindo do SHA revisado de `marks/main`. Nunca trocar branch na árvore compartilhada, nem usar `reset --hard`, `git clean`, `git push --force` ou escolher `ours`/`theirs` globalmente.
- Usar os comandos reproduzíveis em [references/commands.md](references/commands.md); os scripts não fazem fetch nem publicam releases. Preflight e local-release recusam worktrees sujas. Guardar o manifesto de preflight fora da worktree, em diretório privado com permissão restrita.

## Integração
1. Consultar `node scripts/check-community-release.mjs` para a release estável; conferir a URL oficial de cada remote. Buscar a tag exata para a referência de acompanhamento isolada, por exemplo
   `git fetch --no-tags upstream refs/tags/vX.Y.Z:refs/remotes/upstream/releases/vX.Y.Z`.
2. Anotar os commits com `git rev-parse refs/remotes/marks/main^{commit}` e `git rev-parse refs/remotes/upstream/releases/vX.Y.Z^{commit}`. Criar a nova worktree a partir do SHA Marks e executar `merge-guard.mjs preflight` com os dois SHAs. **Salvar o manifesto antes de iniciar merge**.
3. Na worktree limpa e validada, `git merge --no-commit --no-ff refs/remotes/upstream/releases/vX.Y.Z`.
4. Resolver somente os conflitos listados por `git diff --name-only --diff-filter=U`: preservar ambos os lados sem reintroduzir bugs; mesclar catálogos de tradução por **chave**; nunca descartar ou duplicar integrações Marks silenciosamente.
5. Usar a revisão calculada no preflight: `package.json` e lockfile recebem `X.Y.Z+N`; `APP_VERSION`, manifest da extensão e `electron-builder.yml` recebem `X.Y.Z.N` e `buildNumber: 'N'`. Um novo upstream geralmente inicia em `N=1`; para mesma base, incrementar a revisão existente.
6. Reunir novidades do upstream com What's New, CHANGELOG, traduções e `docs/release-notes/vX.Y.Z.N.md`. Links de release do Marks devem ir para `mvclaudianobj/chat-on-steroids`.

## Checklist obrigatório de preservação
- Login MarksPanel obrigatório, sete dias **desde a autenticação**, refresh sem prolongar o prazo; caminhos de IPC/MCP/CLI protegidos.
- Menu, sessões e terminais de projeto de MarksCode, MarksClaw, Codex e Claude, atalhos e branding Chat Marks.
- `icon_marks.png` como fonte de ícones NSIS, Linux, atalhos e janela em runtime; mascote Marks.
- Skills/Marks Agency, importação segura, fonte/proveniência de GitHub e alterações locais não afetadas.
- Updater, identidade do app e extensão, release assets e checksums coerentes com o commit real.
- Compatibilidade com recursos novos da comunidade; não remover código novo apenas porque difere do fork.

## Verificação em duas etapas, sem builds duplicados
1. **Gate rápido local:** depois da revisão/commit, executar `local-release.mjs --head <sha> --level build` primeiro em pré-visualização e depois com `--execute yes`: `verify-release-version`, typecheck, testes focados informados, build. `git diff --check` ainda é obrigatório antes do commit. `--level package` executa o empacotamento nativo existente (incluindo o build uma única vez), que já faz o smoke em cada arquitetura solicitada e usa `--publish never`.
2. **Gate de SHA:** usar `merge-guard.mjs compare-sha --ref <commit-ou-tag> --expected <sha>` para verificar origem Git; acrescentar `--directory <dir> --sums <dir>/SHA256SUMS.txt` para conferir cada artefato listado, sem links simbólicos ou nomes ambíguos. **Hash de arquivo não prova o commit que o compilou**: confrontar também o SHA do job/candidato e o SHA imutável da tag antes de reutilizar qualquer pacote.
3. **Rollback seguro:** se a integração falhar, executar `merge-guard.mjs recovery --record <preflight.json> --destination <novo-caminho> --branch recovery/<nome>`; conferir o dry-run e somente então usar `--execute yes`. Isso cria uma worktree nova no SHA-base validado e **preserva integralmente** a worktree problemática, seus arquivos e commits. Não apagar, abortar merge, restaurar index nem fazer checkout na árvore compartilhada automaticamente.
4. **Gate de distribuição (uma execução por commit/tag):** GitHub Actions para sistemas não disponíveis localmente e smoke de instaladores específicos. Reutilizar candidatos apenas quando tag/commit/versão/checksums forem idênticos. Não rodar canary completo e publish completo duplicados por rotina.
5. Confirmar `git merge-base --is-ancestor <base-marks> HEAD` e `git merge-base --is-ancestor <upstream-sha> HEAD`. Inspecionar mudanças exclusivas e testar o comportamento, não apenas procurar arquivos.
6. Commit de merge com ambos os pais, push do branch e PR para `marks/main` **após autorização**; release/tag somente quando requisitos da plataforma e o usuário autorizarem lançamento. Nunca regravar releases já publicadas.

## Relatório final
Registrar SHA upstream, SHA Marks anterior, SHA merge, manifesto de preflight, SHA de candidato CI, arquivos e checksums verificados, conflitos resolvidos, recursos preservados, testes realmente executados, bloqueios nativos e estado **separado** de código mesclado / tag / artefatos publicados / atualização detectável.
