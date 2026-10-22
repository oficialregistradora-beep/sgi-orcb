# Modelo de dados

DDL executável: `db/migrations/0001_fundacao.sql`, `0002_pessoas_jornada.sql` e `0003_dados_referencia.sql`. Convenções: chaves UUID; `timestamptz` para instantes; `date` para competências locais (America/Sao_Paulo); `numeric(12,2)` para dinheiro; minutos inteiros para durações.

## Entidades implementadas (Fases 1–2)
| Tabela | Finalidade | Proteções |
|---|---|---|
| `sectors`, `job_titles` | Estrutura organizacional configurável | Únicos por código/nome |
| `users` | Contas (e-mail institucional, vínculo Google `sub`, TOTP criptografado) | Uma única conta `is_owner` |
| `sessions` | Sessões no servidor (hash do token, MFA, reautenticação, revogação) | — |
| `permissions`, `roles`, `role_permissions` | RBAC com escopo PROPRIO/SETOR/TODOS | Permissões globais só em TODOS |
| `user_roles` | Atribuições com setor coordenado e **vigência** (substituições) | Revogação registrada, nunca apagada |
| `audit_log` | Trilha encadeada por SHA-256 | Imutável (UPDATE/DELETE/TRUNCATE bloqueados); `fn_audit_verify()` |
| `settings` | Parâmetros institucionais | Alteração auditada |
| `notifications` | Avisos internos | — |
| `employees` | Cadastro funcional | Coerência entre situação e data de desligamento |
| `employee_sensitive` | CPF, RG, nascimento, endereço, telefone, banco, saúde | AES-256-GCM por campo; CPF com HMAC único |
| `job_history`, `salary_history` | Histórico de cargo/setor e salário | Salário imutável |
| `work_schedules`, `work_schedule_days` | Jornadas contratuais e tolerância | Coerência de horários |
| `employee_schedules` | Jornada por vigência | Sem sobreposição (EXCLUDE/GiST) |
| `holidays`, `absences` | Calendário e ausências (abonadas ou não) | — |
| `hour_bank_agreements` | Acordo de banco (individual ≤ 6 meses; coletivo ≤ 12) | CHECK do prazo legal |
| `requests` | Correção, compensação, autorização prévia | Decisão exige autor |
| `time_punches` | Marcações (WEB, CORRECAO, IMPORTACAO) | **Imutável**; horário WEB definido pelo banco |
| `punch_annulments` | Desconsideração aprovada | Imutável; 1 por marcação |
| `daily_records` | Apuração diária (recalculável) | PK funcionário+data |
| `daily_occurrences` | Extra / diferença negativa / incompleta | Resoluções compatíveis por tipo; 1 viva por dia e tipo |
| `hour_bank_entries` | Razão do banco (crédito, compensação, cobertura, pagamento, estorno) | Imutável; 1 lançamento por ocorrência/solicitação |
| `hour_bank_allocations` | Consumo PEPS débito→crédito | Imutável |
| `period_closings` | Fechamento/reabertura de competência | 1 fechamento ativo por competência |
| `documents`, `document_versions`, `signatures` | Documentos, versões com hash e assinaturas com evidências | Versões e assinaturas imutáveis |

| `document_categories` | Categorias do repositório (revisão e retenção padrão) | Retenção só com fundamento |
| `documents` (colunas da Fase 3) | Documento do repositório (`reference_type = 'REPOSITORIO'`): situação, público, confidencialidade, rascunho, versão vigente e pendente, revisão, retenção | CHECK de consistência por situação; código único |
| `document_files` | Arquivos (bytea) com SHA-256 | Imutáveis; só o descarte do conteúdo é permitido, uma vez |
| `document_version_reviews` | Submissão e decisão de cada versão | Decisão imutável; quem submete não decide (CHECK); aprovação exige assinatura |
| `document_audience_sectors`, `document_audience_users` | Público destinatário / lista de acesso | — |
| `document_events` | Histórico do documento | Imutável |

## Entidades previstas (Fases 2b–5)
`oncall_schedules` / `oncall_shifts` / `oncall_calls` (plantões RCPN, com sobreaviso, trabalho efetivo e banco **separados**), `vacation_requests`, `drive_files` (se o Drive for adotado — ADR 0009), `tasks`, `projects`, `project_phases`, `task_dependencies`, `workflows`, `workflow_steps`, `suppliers`, `contracts`, `expenses`, `cost_centers`, `budgets`, `payments` (com segregação solicitante/aprovador/pagador), `trainings`, `training_records`, `evaluations`, `audits`, `nonconformities`, `corrective_actions`, `risks`, `incidents`, `assets`, `automations`.
