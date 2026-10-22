# Rodada 2 — Segurança e integração (25 casos + backup/restauração + E2E)

| Verificação | Resultado |
|---|---|
| UPDATE/DELETE em marcações; UPDATE/DELETE/TRUNCATE na auditoria; UPDATE/DELETE no razão, nas alocações e no salário | Bloqueados pelo banco (com linhas existentes) |
| Marcação WEB com horário forjado pelo cliente | Ignorado: o horário é definido pelo servidor |
| Cadeia de auditoria | Íntegra; adulteração direta (com triggers desabilitados pelo dono) **detectada** |
| Colaborador acessando dados de outro (perfil, banco, ocorrências, listagens) | Negado |
| Coordenação acessando outro setor | Negado |
| Substituta Legal sem delegação acessando sensíveis/salário | Negado; a consulta da Oficial é auditada |
| Dados sensíveis e salário em repouso e na auditoria | Cifrados; ausentes da trilha |
| Decidir a própria solicitação; autoatribuir papel | Negado |
| Operações críticas sem reautenticação ou com reautenticação expirada (11 min) | Negado |
| 6 marcações simultâneas | Exatamente 1 gravada |
| 2 aprovações simultâneas disputando o mesmo crédito | Exatamente 1 aprovada; saldo correto |
| Mesma solicitação decidida em paralelo | Processada uma única vez |
| Desligamento | Sessões ativas invalidadas; registros e saldo preservados |
| Backup → restauração (`scripts/backup-restore-test.sh`) | Contagens idênticas em 33 tabelas; cadeia íntegra no restaurado |
| E2E: rota sem sessão, API de outro funcionário, POST de origem externa, CSP | Redireciona; 404; 403; nenhuma violação |

**Não testado nesta rodada (dependente de configuração):** integração Google real (cliente OAuth inexistente — testadas apenas as regras de validação das claims); comportamento sob indisponibilidade do Google; implantação em nuvem; varredura automatizada de vulnerabilidades (DAST) e auditoria ASVS formal.
