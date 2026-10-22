# ADR 0006 — Apuração diária sob demanda (sem agendador obrigatório)

**Decisão.** Os dias até "ontem" são apurados quando o painel, o banco de horas ou as ocorrências são acessados (`ensureProcessed`), com advisory lock por funcionário. A rota `/api/cron/processar` existe para o Cloud Scheduler, mas é opcional.
**Motivo.** Elimina um componente de infraestrutura e funciona com Cloud Run escalando a zero.
**Reprocessamento.** Mudanças em marcações, ausências e jornadas reprocessam o período afetado. Ocorrências já decididas cujo valor muda são "superadas" e o lançamento correspondente é estornado automaticamente; a decisão anterior permanece no histórico.
