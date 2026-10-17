# Guia de Ferramentas — chat-on-steroids

## Work Orchestrator

Ferramentas e comandos disponíveis via `work` CLI:

| Comando | Descrição |
|---------|----------|
| `work open chat-on-steroids` | Abre o projeto no Terminator |
| `work status chat-on-steroids` | Exibe status do projeto |
| `work attach chat-on-steroids` | Conecta à sessão tmux do projeto |
| `work save` | Salva o workspace atual |
| `work restore` | Restaura o workspace salvo |
| `work snapshot chat-on-steroids` | Cria snapshot manual da sessão |

## Agentes de Desenvolvimento

| Agente | Config | Uso |
|--------|--------|-----|
| Claude | `.claude/CONTEXT.md` | Desenvolvimento com Claude Code |
| Codex | `.codex/CONTEXT.md` | Desenvolvimento com OpenAI Codex |
| Markscode | `.markscode/CONTEXT.md` | Agente Marks local |
| Opencode | `.opencode/CONTEXT.md` | OpenCode CLI |

## Integração Work + Agentes

Os agentes leem automaticamente seus respectivos diretórios de contexto.
Mantenha os arquivos em `.work/` atualizados para memória compartilhada.
