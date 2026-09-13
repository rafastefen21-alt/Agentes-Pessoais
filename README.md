# Assistente pessoal com IA (WhatsApp + e-mail + agenda)

Uma assistente que lê o WhatsApp e os e-mails de uma pessoa, avisa no próprio WhatsApp dela o que é urgente, sugere respostas prontas, manda resumos periódicos e ajuda com a agenda. Funciona para várias pessoas ao mesmo tempo: cada uma tem sua instância de WhatsApp (Evolution API), sua caixa de e-mail e suas preferências, tudo gerenciado num portal.

## O que ela faz

| Situação | O que acontece |
|---|---|
| Chega mensagem no WhatsApp ou e-mail | Espera ~1 min para juntar mensagens picadas, lê o histórico da conversa e a agenda, e classifica com IA: urgência (baixa/média/alta/crítica), categoria, resumo, se precisa de resposta, sugestão de resposta e prazo. |
| É urgente | Manda um aviso na conversa **"Você"** do WhatsApp da pessoa: resumo + sugestão de resposta + `enviar #12` para mandar. |
| Não é urgente | Fica na lista de pendências e entra no próximo resumo. |
| Horários configurados (ex.: 08:00, 13:00, 18:00) | Manda o resumo: o que precisa de resposta, agenda de hoje/amanhã, conflitos e o resto em uma linha. |
| A pessoa responde na conversa "Você" | `enviar #12`, `resumo`, `agenda`, `feito #12`, `ajuda`, ou texto livre ("responde pro João que amanhã às 10h fica bom", "o que a Maria queria?"). A assistente só envia mensagem a terceiros quando a pessoa pede explicitamente. |
| A pessoa responde o contato por conta própria | A pendência daquela conversa é fechada automaticamente. |

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
                                          Evolution sendText ◀──┘  → WhatsApp da pessoa (conversa "Você")

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
2. **WhatsApp → Conectar / gerar QR**: escaneia no celular da pessoa (Aparelhos conectados). O número é detectado sozinho.
3. **E-mail**: servidor IMAP (há presets: Gmail, Outlook, iCloud…), usuário e senha de app. "Testar conexão" e salvar. Só e-mails novos a partir daí são lidos.
4. **Agenda**: link ICS secreto do Google Agenda ou Outlook.
5. **Preferências**: horários dos resumos, período de silêncio, a partir de qual urgência avisar na hora.
6. Clique em **Mensagem de teste**: a pessoa recebe um "oi" da assistente na conversa "Você".

### Número dedicado da assistente (opcional)

Por padrão a assistente escreve na conversa "Você" (mensagem para o próprio número), então não precisa de nenhum número extra. Se preferir que os avisos venham de um número separado, conecte esse número numa instância da Evolution, informe o nome em `ASSISTANT_INSTANCE` e, na pessoa, escolha "Avisar por: número dedicado".

## Custos e privacidade

- Cada conversa com mensagens novas gera uma chamada ao Claude (com cache do prompt). Ajuste `CLAUDE_TRIAGE_EFFORT` para `low` se quiser reduzir custo.
- Senhas de e-mail ficam criptografadas (AES-256-GCM) com `APP_SECRET`/`data/secret.key`.
- Mensagens ficam no banco (Supabase). Apagar a pessoa no portal apaga tudo dela e a instância na Evolution.

## Diagnóstico

- **Status do sistema** mostra a Evolution, a IA, pendências de configuração e os últimos webhooks recebidos.
- Se o QR não aparece: veja `PROMPT-EVOLUTION-API` (versão da imagem e `CONFIG_SESSION_PHONE_VERSION` na Evolution).
- Se conectou mas nada chega: "Verificar webhook" na aba WhatsApp mostra a URL registrada na Evolution; ela deve apontar para `APP_URL`.
- Logs no console (`LOG_LEVEL=debug` para ver uso de tokens).
