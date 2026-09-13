# Assistente pessoal com IA (WhatsApp + e-mail + agenda)

Uma assistente que lê o WhatsApp e os e-mails de uma pessoa, avisa no próprio WhatsApp dela o que é urgente, sugere respostas prontas, manda resumos periódicos e ajuda com a agenda. Funciona para várias pessoas ao mesmo tempo: cada uma tem sua instância de WhatsApp (Evolution API), sua caixa de e-mail e suas preferências, tudo gerenciado num portal.

## O que ela faz

| Situação | O que acontece |
|---|---|
| Chega mensagem no WhatsApp ou e-mail | Espera ~1 min para juntar mensagens picadas, lê o histórico da conversa e a agenda, e classifica com IA: urgência (baixa/média/alta/crítica), categoria, resumo, se precisa de resposta, sugestão de resposta e prazo. |
| É urgente | Manda um aviso pelo **número da assistente** da pessoa (um chip exclusivo dela): resumo + sugestão de resposta + `enviar #12` para mandar. |
| Não é urgente | Fica na lista de pendências e entra no próximo resumo. |
| Horários configurados (ex.: 08:00, 13:00, 18:00) | Manda o resumo: o que precisa de resposta, agenda de hoje/amanhã, conflitos e o resto em uma linha. |
| A pessoa responde para a assistente | `enviar #12`, `resumo`, `agenda`, `feito #12`, `ajuda`, ou texto livre ("responde pro João que amanhã às 10h fica bom", "o que a Maria queria?"). A assistente só envia mensagem a terceiros quando a pessoa pede explicitamente. |
| A pessoa responde o contato por conta própria | A pendência daquela conversa é fechada automaticamente. |
| O WhatsApp da pessoa conecta | Cerca de 1,5 min depois, a assistente importa as conversas recentes e aprende um **perfil**: como a pessoa escreve (tom, tamanho, saudações, expressões, exemplos reais), quem são os contatos importantes e o que costuma ser prioridade. Esse perfil entra em toda triagem, resumo e sugestão de resposta, e é renovado a cada 7 dias (ou em Preferências → Perfil aprendido → Reaprender). |

## Arquitetura

```
Evolution API (WhatsApp)  ──webhook──▶  src/routes/webhooks.js ─┐
Caixa IMAP (e-mail)       ──polling──▶  src/email.js ───────────┤
Calendário ICS (agenda)   ──polling──▶  src/calendar.js ────────┤
                                                                ▼
                                                    src/agent.js  (triagem, avisos, resumos, comandos)
                                                                │
                                                    src/ai/claude.js (Claude Opus 5, saída estruturada)
                                                                │
                                          Evolution sendText ◀──┘  → número da assistente → WhatsApp da pessoa

Portal (public/ + src/routes/api.js): cadastra pessoas, conecta WhatsApp (QR), e-mail, agenda, preferências,
                                      vê pendências, mensagens lidas e a conversa com a assistente.
Banco: Postgres do Supabase (DATABASE_URL) — ou SQLite local em data/assistente.db quando DATABASE_URL está vazia
```

## Onde roda

| Peça | Onde |
|---|---|
| Portal + agente (webhooks, e-mail, resumos, IA) | **Railway** (processo Node 24h; tem `Dockerfile`) |
| Banco (pessoas, mensagens, pendências, agenda) | **Supabase** (Postgres) |
| WhatsApp | **Evolution API** (já no Railway) |

O Supabase sozinho não serve para hospedar o agente: ele precisa de um processo sempre ligado (webhooks, leitura de e-mail a cada 3 min, temporizadores dos resumos).

## Requisitos

- Node.js 22.13+ (testado no 24)
- Um projeto no Supabase (banco Postgres)
- Uma Evolution API v2 no ar (imagem `evoapicloud/evolution-api:v2.3.x`) com a `AUTHENTICATION_API_KEY` global
- Chave da API da Anthropic (`ANTHROPIC_API_KEY`)
- Uma URL pública para este servidor (a Evolution precisa chamar o webhook)

## Rodando localmente

```bash
npm install
copy .env.example .env      # e preencha ADMIN_PASSWORD, EVOLUTION_URL, EVOLUTION_APIKEY, ANTHROPIC_API_KEY
npm start
```

Abra http://localhost:3000, entre com a senha e vá em **Status do sistema** para conferir a Evolution e a IA.

Para a Evolution alcançar o seu computador, exponha a porta 3000 com um túnel e coloque a URL em `APP_URL`:

```bash
cloudflared tunnel --url http://localhost:3000
```

(ou `ngrok http 3000`). Reinicie o servidor depois de alterar o `.env`. Ou use `iniciar.bat`.

## Banco no Supabase

1. No Supabase: **Project Settings → Database → Connection string → URI**, opção **Transaction pooler** (porta 6543). Copie para `DATABASE_URL` (troque `[YOUR-PASSWORD]` pela senha do banco).
2. As tabelas são criadas sozinhas quando o servidor sobe. Se preferir criar antes, rode `supabase/schema.sql` no SQL Editor.
3. As tabelas ficam com **RLS ligado e sem políticas**: a API pública do Supabase (anon key) não enxerga nada; só este servidor, pela conexão direta. Não desligue o RLS.
4. Com `DATABASE_URL` vazia, o app usa SQLite local (`data/assistente.db`) — útil para testar no computador.

## Rodando no Railway (recomendado para ficar 24h no ar)

1. Crie um serviço a partir desta pasta (há `Dockerfile`).
2. Variáveis: as do `.env.example`, com `DATABASE_URL` do Supabase e `APP_SECRET` preenchido (uma string longa aleatória — é ele que criptografa as senhas de e-mail; sem ele a chave seria gerada no disco do container e se perderia no deploy).
3. `APP_URL` = domínio público gerado pelo Railway (Settings → Networking → Generate Domain).
4. Deploy. O portal fica em `APP_URL`.

## Configurando uma pessoa

1. **Pessoas → Nova pessoa**: nome, contexto (quem é, prioridades, clientes VIP, tom) e se lê grupos.
2. **WhatsApp**: duas conexões, cada uma com seu QR:
   - **WhatsApp da pessoa (leitura)**: escaneia no celular da própria pessoa (Aparelhos conectados). O número é detectado sozinho.
   - **Número da assistente**: um chip exclusivo dessa pessoa, de onde a assistente escreve e recebe os comandos. Escaneia no aparelho que tem esse chip. Peça para a pessoa salvar o contato.
3. **E-mail**: servidor IMAP (há presets: Gmail, Outlook, iCloud…), usuário e senha de app. "Testar conexão" e salvar. Só e-mails novos a partir daí são lidos.
4. **Agenda**: link ICS secreto do Google Agenda ou Outlook.
5. **Preferências**: horários dos resumos, período de silêncio, a partir de qual urgência avisar na hora.
6. Clique em **Mensagem de teste**: a pessoa recebe um "oi" da assistente na conversa "Você".

### Por que um número de assistente por pessoa

Cada pessoa tem **duas instâncias** na Evolution: o WhatsApp dela (só leitura, e de onde saem as respostas aos contatos) e o número da assistente (por onde ela conversa com a pessoa). Não existe um número central: se o número da assistente de alguém cair, só aquela pessoa é afetada, e mesmo assim os avisos continuam chegando pela conversa "Você" do próprio WhatsApp dela até reconectar.

Se preferir não usar um chip extra para alguma pessoa, em Preferências escolha "Avisar por: conversa Você" — a assistente passa a escrever na conversa da pessoa com ela mesma, marcando as mensagens com 🤖.

## Área do cliente ("Minha assistente")

Cada pessoa pode ter um login próprio em `APP_URL/cliente` (e-mail e senha definidos pelo admin em **Preferências → Acesso do cliente**). Lá ela vê só os próprios dados: gasto com IA no mês, números do mês (mensagens lidas, pendências, urgentes, resolvidas), o relatório do mês escrito pela assistente (resumo, principais pontos, agenda e recomendações) e a agenda. O relatório é gerado na primeira visita ao mês e fica em cache; o botão "Atualizar" regera no máximo a cada 6 h. O admin vê o mesmo relatório na aba **Relatório mensal** da pessoa.

No topo do painel a pessoa vê as duas conexões (o WhatsApp dela e o número da assistente). Se alguma cair, ela clica em **Reconectar agora**, escaneia o QR e volta a funcionar sem depender do admin. O cliente só pode conectar; recriar instância, desconectar e webhook continuam só no portal do admin.

## Design

Portal e área do cliente seguem o material Liquid Glass (Apple): barra e controles translúcidos com blur sobre um fundo colorido, conteúdo em superfícies mais opacas, formas em cápsula, tinta só na ação primária, claro/escuro automático. Sem emojis: ícones de linha em `public/icons.js`.

## Custos e privacidade

- Cada conversa com mensagens novas gera uma chamada ao Claude (com cache do prompt). Ajuste `CLAUDE_TRIAGE_EFFORT` para `low` se quiser reduzir custo.
- **Gasto por pessoa no portal**: toda chamada à IA é registrada na tabela `api_usage` com tokens e custo estimado. A aba **Custos** de cada pessoa mostra hoje / 7 dias / mês / 30 dias / total, por tipo (triagem, resumo, conversa) e por dia; a página **Status do sistema** mostra o ranking do mês. Defina `USD_BRL_RATE` para ver também em reais. A tabela de preços fica em `src/ai/claude.js` (`PRICES`); a fatura oficial é a do console da Anthropic.
- Senhas de e-mail ficam criptografadas (AES-256-GCM) com `APP_SECRET`/`data/secret.key`.
- Mensagens ficam no banco (Supabase). Apagar a pessoa no portal apaga tudo dela e a instância na Evolution.

## Diagnóstico

- **Status do sistema** mostra a Evolution, a IA, pendências de configuração e os últimos webhooks recebidos.
- Se o QR não aparece: veja `PROMPT-EVOLUTION-API` (versão da imagem e `CONFIG_SESSION_PHONE_VERSION` na Evolution).
- Se conectou mas nada chega: "Verificar webhook" na aba WhatsApp mostra a URL registrada na Evolution; ela deve apontar para `APP_URL`.
- Logs no console (`LOG_LEVEL=debug` para ver uso de tokens).
