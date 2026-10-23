# ADR 0013 — Google Agenda, Gmail e Chat

**Situação:** aceita (Fase 4c, 23/10/2026). Complementa as ADRs 0009/0010 (Drive).

## Consistência
- **Gmail e Chat — fila na mesma transação (outbox):** a mensagem é gravada em `integration_outbox` na transação do fato que a origina. Se a operação falhar, nada é enviado; se o Google falhar, a operação **não** é desfeita. Envio com chave idempotente, reserva de lote (`SKIP LOCKED`, sem envio duplicado sob concorrência), espera crescente (2ⁿ min, até 24 h), no máximo 8 tentativas, erros permanentes (4xx) direto para FALHA, reenvio manual pela administração, descarte após 7 dias (evita disparos tardios em massa).
- **Agenda — reconciliação:** o banco é a fonte da verdade. A sincronização calcula os eventos desejados (férias, plantões, marcos, compensações, eventos institucionais), compara com os vínculos (`calendar_links`, com hash do conteúdo) e cria, atualiza ou remove. Idempotente, uma execução por vez (trava consultiva), recria eventos apagados diretamente no Google e remove os de tipos desligados.
- **Quando roda:** rotina agendada (`/api/cron/processar`, e `?somente=integracoes` a cada 5–15 min), botão na tela de Integrações e envio oportunista ao final de cada ação.

## Privacidade e escopos mínimos
- **E-mail** leva só o título do aviso e o link; o conteúdo fica no sistema, atrás de autenticação e MFA. Somente para notificações de prioridade alta (parâmetro). Remetente: uma caixa do domínio, por delegação restrita ao escopo `gmail.send`.
- **Chat** (webhook de entrada de um espaço, sem OAuth e sem leitura): apenas avisos administrativos e anúncios institucionais; documento só é anunciado se for **interno e destinado a todos**.
- **Agenda:** férias e compensações são dados pessoais; compensações começam **desligadas** e a publicação de férias deve ser avaliada com o encarregado de dados (P-06). Cada tipo é ligado/desligado na tela, sem código.
- **Escopos:** `calendar.events`, `gmail.send`, `drive` (opcional). Exibidos na tela de Integrações e no guia (docs/23). Nenhuma senha Google é armazenada.
- **Produção:** endereços de API não podem ser substituídos; webhook só de `chat.googleapis.com`; remetente só do domínio institucional.

## Autenticação
Conta de serviço com chave (Secret Manager) ou, no Cloud Run, identidade do serviço; para a delegação do Gmail sem chave, o JWT é assinado pela API IAM Credentials (`signJwt`). Esse caminho sem chave **não foi testado** (exige o ambiente Google real); o caminho com chave foi testado contra a API simulada.

## Agenda interna
A página *Agenda* mostra os mesmos fatos dentro do sistema, com as regras de acesso de cada módulo de origem — funciona mesmo sem o Google.
