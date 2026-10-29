# Chat Marks — WhatsApp bidirecional (candidata -31)

**Experimento opt-in. Não habilitado automaticamente ao atualizar.** O WhatsApp Web/Baileys é uma integração não oficial. O aplicativo não deve ser usado para enviar mensagens em massa.

## Configurar

1. Em **Configurações → Notificações → WhatsApp Web (QR)**, mantenha o WhatsApp conectado (a sessão pareada é reutilizada após reiniciar).
2. Ative **Enabled** para esse canal e informe em **Phone numbers** o número **do outro celular que controlará o Chat Marks**, com DDI/DDD e somente dígitos (ex.: `5511999999999`). Um número diferente do WhatsApp pareado deve iniciar a conversa, pois mensagens `fromMe` são ignoradas para evitar loops.
3. Ative **Two-way chat and approvals / Chat bidirecional e aprovações**. Salve as configurações de notificação. Desative essa opção a qualquer momento para revogar comandos recebidos.
4. No telefone autorizado, envie `/menu` para o número do WhatsApp pareado. Selecione `/chats`, depois `/usar 1`. Envie qualquer texto para enfileirá-lo no ChatGPT com os mecanismos normais do Chat Marks.

## Menu

| Comando | Ação |
| --- | --- |
| `/menu`, `/ajuda` | Exibe o menu disponível |
| `/chats` | Lista até 12 sessões recentes do ChatGPT |
| `/ativo` | Mostra o chat selecionado (ou a atividade recente no computador) |
| `/usar 1`, `/usar 2` | Fixa um chat específico; seleção persiste após reiniciar |
| `/usar ativo` | Seleciona o chat com atividade recente no computador |
| `/aprovacoes` | Lista somente solicitações pendentes do chat selecionado |
| `/aprovar ID` ou `/negar ID` | Enfileira decisão humana no cartão exato; **não é permissão permanente e depende de confirmação do próprio ChatGPT** |
| Qualquer texto sem `/` | Entra no outbox durável do chat selecionado e informa que foi enfileirado |

Uma resposta de ChatGPT só retorna pelo WhatsApp após ser registrada no chat correto **e** existir prova de entrega da mensagem exata enviada a partir do telefone. Se o WhatsApp cair, o aplicativo tenta encaminhar a resposta após a recuperação da conexão; sem confirmação do host, não promete entrega.

Nesta primeira versão é permitido **um pedido pendente por número autorizado**; aguarde sua resposta antes do próximo pedido para não associar respostas de turnos diferentes. O comando `/usar` pode selecionar outro chat e cancela o acompanhamento anterior.

## Segurança, privacidade e limitações

- Somente números exatos, autorizados e habilitados na opção própria; grupos, status, mensagens próprias e endereços @lid sem número verificável são ignorados. Se os seus contatos usam WhatsApp LID sem JID telefônico, o canal não reconhecerá essas mensagens nesta candidata.
- O controle exige um segundo número autenticado no WhatsApp; ter acesso ao número autorizado permite executar comandos e solicitar decisões de aprovação neste app. Não habilite números compartilhados.
- O sistema persiste seleção do chat, identidade/deduplicação da mensagem recebida e acompanhamento de resposta, mas **não grava textos de conversas nesse novo arquivo de controle**.
- O `sendDesktopInput` confirma inicialmente **admissão na fila**, não entrega na interface do ChatGPT. Os recibos reais continuam sob controle da sessão e da extensão.
- Uma aprovação não é um grant permanente; a página do ChatGPT ainda precisa confirmar o clique em um cartão válido. Cartões alterados/expirados são recusados.
- Há suporte de transporte para MP3 válido em memória (`sendWhatsAppWebMp3`) preparado para uma futura integração do Jarvis. **A geração TTS Gemini/G4F e o disparo de áudio automático ainda não estão integrados.**
- Nenhum WhatsApp real, aparelho secundário ou conexão de rede foi usado nos testes automáticos da candidata.
