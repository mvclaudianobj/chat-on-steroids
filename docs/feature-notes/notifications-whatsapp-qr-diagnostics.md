# Diagnóstico de início do WhatsApp Web QR — homologação 2.1.45.2

O erro reportado na instalação Debian 2.1.45.2-2 dizia para revisar o *token de bot* ao conectar o WhatsApp. Esse texto era compartilhado pelo Telegram e WhatsApp Web; o WhatsApp Web não usa token. A resposta do IPC ocultava toda exceção, então **a causa efetiva da falha no perfil instalado não pôde ser determinada sem abrir a sessão real** (ação deliberadamente evitada).

## Verificações seguras

- Base exata: commit de candidata `0c601a87`, descendente de `bf782ef9`, worktree isolada `qr-21452-fix`. Nenhum perfil real, token, pasta de sessão ou aplicação instalada foi aberto ou alterado.
- O arquivo `app.asar` do **artefato de homologação já existente** contém `@whiskeysockets/baileys` (315 entradas), `whatsapp-rust-bridge` (4 entradas), `qrcode` (47 entradas), `ws` (20 entradas) e `pino` (97 entradas). Isso descarta ausência completa dessas dependências nesse artefato; não comprova resolução de todos os módulos em tempo de execução.
- Import e `makeWASocket` reais da versão fixada Baileys `7.0.0-rc14` foram executados com autenticação de diretório temporário e método de conexão WebSocket substituído localmente para **impedir qualquer contato com WhatsApp**. A inicialização síncrona passou, sugerindo que o logger e os módulos básicos carregam sob Node; o runtime Electron empacotado e a rede do usuário não foram testados com pareamento.
- Testes com sockets e filesystem falsos cobrem falha de criação do diretório, leitura inválida, falha de inicialização, desconexão pré-QR e conservação dos arquivos após logout inesperado.

## Correção

- `WhatsAppPairingError` limita a saída a `storage_unavailable`, `session_invalid`, `runtime_unavailable`, `connection_failed`, `qr_timeout`, `qr_render_failed` ou `unknown`. O processo principal retorna `setupCode` no IPC, sem `Error.message`, caminho de sessão, texto de WebSocket ou chave.
- O renderer apresenta mensagens separadas para Telegram e WhatsApp e, durante polling, mostra causas associadas ao estado simplificado; respostas iniciais `connecting` não são anunciadas como QR disponível. Há prazo de 35 segundos para a primeira resposta QR da sessão não registrada, com indicação de tempo esgotado. A UI continua consultando o status.
- Credenciais são preservadas em quedas/logout inesperados. Somente a operação **Desconectar WhatsApp**, escolhida pelo usuário, remove o diretório local.
- Captura Electron com fixture de falha sintética: `notification-whatsapp-storage-failure-synthetic.png` (não contém contas nem QR real). Nenhuma alteração no pacote instalado nem novo `.deb` foi realizada.

## Limites e homologação

A classificação `runtime_unavailable` significa erro durante o construtor Baileys; o empacotamento não foi provado como causa. Um operador pode repetir o botão na próxima candidata e relatar **apenas o código seguro** visível na tela. O pareamento real, conectividade WebSocket na máquina e compatibilidade futura com Baileys RC exigem verificação manual autorizada em ambiente de teste. Não enviar arquivos de sessão nem tokens para diagnosticar.
