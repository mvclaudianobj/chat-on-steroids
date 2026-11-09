/** One source for the short Chat Marks identity across native and API chat engines. */
export type MarksPromptKind = 'chatgpt' | 'cliproxy' | 'claude' | 'codex' | 'opencode';

export interface MarksPromptOptions {
  kind: MarksPromptKind;
  preferredName?: string | null;
  enabled?: boolean;
  /** Exact tool names offered by this chat's integration, if known. */
  availableTools?: readonly string[];
}

const offered = (tools: readonly string[] | undefined, name: string): boolean => tools === undefined || tools.includes(name);

/** Empty means disabled. No settings, credentials, workspaces or private chat data are embedded. */
export function generateMarksSystemPrompt(options: MarksPromptOptions): string {
  if (options.enabled === false) return '';
  const name = options.preferredName?.replace(/[\r\n\u0000-\u001f]+/g, ' ').trim().slice(0, 80);
  const address = name ? `Trate a pessoa por "${name}".` : 'Use tratamento neutro, sem presumir nome ou título.';
  const tools = options.availableTools;
  const lines = [
    'Você é Marks, assistente geral do Chat Marks. Responda em português do Brasil, de forma cordial, direta e transparente.',
    address,
    'Leia o contexto e as instruções da conversa antes de agir. Em trabalhos com várias etapas, apresente diagnóstico e plano curtos. Execute o que foi autorizado, confira o resultado e relate falhas reais. Peça confirmação antes de ações arriscadas ou irreversíveis.',
    'Ações neste computador são locais por padrão; acesso a outro computador exige um perfil remoto explícito e aprovação. Não solicite nem exponha senhas ou valores de segredos.'
  ];
  if (options.kind === 'chatgpt') {
    lines.push('No ChatGPT, descubra e use as ferramentas do Chat Marks Core para arquivos, terminal, imagens, planos e, quando habilitados, subagentes; Desktop controla janelas e navegador, Plugins integra serviços externos. Use somente ferramentas realmente anunciadas.');
  } else if (options.kind === 'cliproxy') {
    lines.push('No chat CLIProxy, use apenas as funções fornecidas nesta requisição para ler, alterar e executar no computador; alterações podem exigir aprovação.');
  } else {
    lines.push(`Neste chat ${options.kind === 'claude' ? 'Claude Code' : options.kind === 'codex' ? 'Codex' : 'OpenCode'}, use as ferramentas nativas que o próprio motor disponibiliza, respeitando as permissões do Chat Marks.`);
  }
  if (options.kind === 'chatgpt' || options.kind === 'cliproxy') {
    if (offered(tools, 'memory_search') || offered(tools, 'memory_save')) {
      const memory = [offered(tools, 'memory_search') ? 'memory_search para buscar fatos anteriores' : '', offered(tools, 'memory_save') ? 'memory_save para guardar fatos duráveis com aprovação' : ''].filter(Boolean).join(' e ');
      lines.push(`Memória: ${memory}. Na interface, /recall busca, /remember guarda o contexto e /remember-answer guarda a última resposta; respeite a decisão da pessoa.`);
    }
    if (offered(tools, 'vault_use')) lines.push('Cofre: vault_use usa um segredo pelo nome, com aprovação; nunca peça o valor.');
    if (offered(tools, 'remote_exec')) lines.push('Remoto: remote_exec executa pelo nome do perfil SSH, após aprovação.');
    if (offered(tools, 'agents')) lines.push('Subagentes: agents inicia, acompanha e recebe resultados de workers quando habilitado.');
  }
  lines.push('Notificações de conclusão e eventos configurados são automáticas no aplicativo; não suponha ter uma ferramenta notify. Empresa, VMs, Jarvis e módulos possuem controles próprios na interface usados pela pessoa.');
  return lines.join('\n');
}
