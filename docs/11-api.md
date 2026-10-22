# API REST v1

Autenticação: cookie de sessão do sistema (mesma sessão da interface, com MFA concluído). Escritas exigem cabeçalho `Origin` igual ao da aplicação. Limite de 120 requisições/min por usuário. Respostas de erro: `{ "erro": "<CODIGO>", "mensagem": "…" }` com 400/401/403/404/409/429.

| Método | Rota | Permissão | Descrição |
|---|---|---|---|
| GET | `/api/v1/health` | pública | Disponibilidade da aplicação e do banco (sem dados) |
| GET | `/api/v1/me` | autenticado | Usuário, funcionário vinculado e permissões efetivas com escopo |
| GET | `/api/v1/ponto` | autenticado | Marcações de hoje e próxima marcação sugerida |
| POST | `/api/v1/ponto` | `jornada.registrar` (próprio) | Registra marcação com horário do servidor → `{id, horario, tipo}` |
| GET | `/api/v1/banco-de-horas?funcionario=<uuid>` | `banco.ver` no escopo | Resumo, lotes PEPS, lançamentos, acordo e pendências |
| GET | `/api/v1/relatorios/folha?periodo=AAAA-MM` | `banco.ocorrencias.tratar` | CSV para a contabilidade (exportação auditada) |
| GET | `/api/v1/documentos/{id}/arquivo/{versão \| rascunho}` | público do documento (versão vigente) ou acesso ao histórico | Download do arquivo como anexo (`nosniff`, CSP `sandbox`, cabeçalho `x-sha256`); hash conferido; auditado; 60/min por usuário; 410 se descartado |
| GET | `/api/v1/documentos/{id}/exportar/{versão}` | idem | Pacote JSON: metadados, conteúdo, hashes, assinaturas e verificação recalculada (auditado) |
| GET | `/api/v1/tarefas/{id}/anexos/{arquivo}` | acesso à tarefa | Download de anexo (mesmas proteções dos documentos) |
| POST | `/api/cron/processar` | `Authorization: Bearer <CRON_SECRET>` (≥ 32 caracteres) | Apuração, avisos de revisão documental, tarefas de rotina (hoje e amanhã) e avisos de prazo (opcional) |
| GET | `/api/auth/google/start` · `/callback` | pública | Fluxo OIDC |
| POST | `/api/auth/dev` | somente homologação | Login de teste com usuários fictícios |

Demais operações da interface usam Server Actions (`app/actions/*`), que chamam os mesmos serviços com as mesmas verificações.
