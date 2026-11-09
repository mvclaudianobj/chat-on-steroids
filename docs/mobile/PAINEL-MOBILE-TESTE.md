# Painel mobile Chat Marks — candidato P0 experimental

## Estado desta versão

O painel está **desativado por padrão** e somente é iniciado depois que a conta
Markspanel é validada. Ele apresenta até 30 sessões recentes, até 20 assentos
da Empresa (sempre marcados como não verificados pelo painel), pendências de
aprovação do host ChatGPT e botões de **Permitir uma vez / Negar**. O clique não
prova autorização; apenas envia a decisão para o cartão exato, a ser conferido
pela página ChatGPT. Erros de página, cartão trocado, revogação e host recusando
permanecem autoridade exclusiva do host.

O painel não permite concessões permanentes, iniciar agentes, executar
comandos, ver segredos, alterar configurações, enviar mensagens ou expor chat
completo. Não existe push, PWA offline, inbox read/ACK permanente ou gestão
de usuários mobile. Essas funcionalidades ainda exigem desenvolvimento.

## Teste estritamente local

1. Encerre normalmente o Chat Marks aberto, sem executar outro processo paralelo.
2. Inicie o executável instalado com a variável `CHAT_MARKS_MOBILE_PANEL=1`.
   O endereço local é `http://127.0.0.1:17893/`. A opção também aceita
   `CHAT_MARKS_MOBILE_PORT` (1 a 65535).
3. Após o login Markspanel, no computador, consulte o token efêmero
   `<userData do Electron>/mobile-panel/access.token` como o mesmo usuário
   Linux, somente em canal privado. Nunca o poste em logs, tickets ou chat.
4. Insira o token no navegador, teste a visão geral, feche/reabra a aba e
   confira que a sessão não permanece autenticada sem novo token.
5. Ao sair do aplicativo, o listener e o arquivo de token são eliminados.
   Uma nova execução gera token diferente.

## Rede do celular: HTTPS obrigatório

Sem configuração adicional, o listener está **somente no loopback**;
`127.0.0.1` do celular não é o computador. Para um teste na rede local,
inicie explicitamente o aplicativo com:

- `CHAT_MARKS_MOBILE_PANEL=1`
- `CHAT_MARKS_MOBILE_HOST=<IP privado local do PC>` (um IP literal)
- `CHAT_MARKS_MOBILE_TLS_CERT=<arquivo PEM do certificado>`
- `CHAT_MARKS_MOBILE_TLS_KEY=<arquivo PEM da chave>`
- opcional `CHAT_MARKS_MOBILE_PORT=17893`

Use certificado TLS **confiável no dispositivo**, que contenha o IP local em
subjectAltName e mantenha a chave privada protegida. A conexão do telefone
deve ser `https://<IP do PC>:17893/`. Sem cert+key a aplicação recusa qualquer
listener não-loopback. Não encaminhe a porta para a internet ou roteador,
nem tente desabilitar a validação TLS; utilize uma VPN com autenticação se
necessitar acesso fora da rede privada. O token via Bearer é necessário mesmo
com HTTPS, não vai em URL/cookies nem fica persistido no navegador.

## Evidência e limites de segurança

O código verifica Host/IP/porta, Origin em mutações, token comparado em
tempo constante, ausência de URL query, limite de leitura do POST,
limites por IP, CSP bloqueando scripts de terceiros, e token de 256 bits
que rotaciona em cada inicialização. Não há autofluxo de Allow: o servidor
somente registra decisão explícita com cardId e conversationId exatos.

A homologação com navegador do celular, certificado e conta reais deve ser
feita pelo usuário depois da instalação da Debian de teste. Os testes
automatizados usam apenas dados sintéticos e loopback.
