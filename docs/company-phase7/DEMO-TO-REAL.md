# Empresa: preservar a demonstração e iniciar dados reais

Esta funcionalidade depende da integração e instalação de uma versão que contenha o fluxo de migração. A versão -7 instalada antes desta entrega ainda não o oferece. A instalação e a autenticação real não fazem parte deste patch.

## Fluxo humano no aplicativo

1. Abra **Empresa**. O banner deve indicar **Demonstração · dados de exemplo**. As cadeiras `marks1..N` são posições configuradas, não workers presentes ou autenticados.
2. Escolha **Preservar demonstração e iniciar Empresa real**. Confira a quantidade de tickets/reuniões de exemplo e cadeiras. O aplicativo solicitará uma confirmação nativa independente do botão da interface. Cancelar mantém o snapshot inalterado.
3. Após confirmar, o processo principal valida e grava o backup versionado em `<userData>/company/demo-backups/<uuid>.json` com permissões de arquivo `0600` e SHA-256 dos dados originais. Só depois publica atomicamente `company.json` com `demo:false`, **zero tickets, reuniões, atividades, execuções e vínculos**. Preserva somente o nome, a quantidade e os nomes das cadeiras configuradas, além dos cargos fixos. Nenhum worker é criado.
4. Enquanto não houver alterações reais, o botão **Restaurar demonstração salva** recupera a cópia, após nova confirmação e verificação do hash. A cópia continua armazenada. Se tickets, configuração, reuniões ou outros dados reais forem modificados, a restauração automática é recusada para evitar perda de trabalho. O backup permanece para recuperação supervisionada; não substitua `company.json` manualmente com o aplicativo aberto.
5. Na Empresa real, escolha **Criar ticket real**; preencha o trabalho e os critérios de aceite. Abra o ticket na coluna Entrada, escolha uma cadeira e clique em **Atribuir cadeira para trabalho real**. Isso o deixa em **Atribuído** sem execução.
6. Abra novamente o ticket e escolha **Autorizar worker real**. A autorização nativa mostra a intenção de despacho. O broker só aceita se as permissões e a identidade daquela execução estiverem disponíveis. Após aceitação comprovada, use **Verificar progresso do broker**, histórico do ticket e **Observabilidade / Inspetor**. Erros e recusas permanecem visíveis; uma cadeira configurada nunca se torna um worker ativo por inferência.

## Provas e limites

Os testes usam HOME/armazenamento descartável, IPC Electron simulado com janela principal e confirmação nativa falsas e backend broker sintético. Casos positivos e negativos cobrem cancelamento, backup íntegro, restauração após reinício, adulteração, estado real alterado, preparação de cadeira sem worker e despacho negado. A interface Electron foi percorrida até uma autorização recusada sem simular `working`.

O broker `/v1/workers/{ownerId}` ainda não fornece atestado criptográfico independente de identidade da plataforma que associe um `marksN` real a uma sessão externa autenticada e ao epoch de concessão. A disponibilidade de workers, quotas rígidas, conta CEO e trabalho pós-login exigem homologação separada. O modo manual continua padrão; esta migração de dados não aprova permissões, credenciais nem delegações.
