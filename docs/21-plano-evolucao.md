# Plano de evolução

| Fase | Entregas | Observações |
|---|---|---|
| 2b ✅ | (Implementado em 22/10/2026) Plantões e sobreaviso RCPN (escala, substituto, chamados, resposta, comparecimento, trabalho efetivo; cálculos separados de sobreaviso, efetivo e banco); solicitação de férias pelo funcionário; checklists de admissão e desligamento (uniformes, equipamentos, termos); relatório diário por setor | J-07 é pré-requisito para os cálculos |
| 3 ✅ | (Implementado em 22/10/2026) Gestão documental: 21 categorias, versões imutáveis com hash, aprovação com segregação, vigência, revisão periódica com aviso, ciência com relatório de cobertura, confidencialidade, obsolescência, arquivamento, retenção com descarte controlado, pesquisa textual, exportação. **3b ✅:** antivírus ClamAV (falha fechada) e armazenamento opcional no Google Drive compartilhado. **Pendentes:** ligação com o Drive real (P-03), migração de arquivos antigos para o Drive, vigência futura, pré-visualização de PDF | ADR 0009, 0010 |
| 4a ✅ | (Implementado em 22/10/2026) Tarefas, projetos (Gantt, quadro, calendário, painel), rotinas recorrentes, processos com etapas e escalonamento — ADR 0011 | — |
| 4b ✅ | (Implementado em 22/10/2026 — ADR 0012) Financeiro gerencial: fornecedores, contratos, despesas fixas e variáveis, compras, orçamentos, centros de custo, contas a pagar, pagamentos, fluxo de caixa, previsto × realizado, anexos; segregação solicitação/aprovação/pagamento | Não substitui o Livro Diário Auxiliar nem a escrituração obrigatória |
| 4c ✅ | (Implementado em 23/10/2026 — ADR 0013; ligação real pendente de P-03) Google Calendar (férias, plantões, reuniões, prazos, treinamentos, compensações), Chat e Gmail, com escopos mínimos e falhas sem afetar o banco | Depende de configuração (P-03) |
| 5 | Auditorias internas, NC/CAPA, riscos, incidentes, inventário de ativos, treinamentos, avaliações (30/60/90 dias, anual, competências, PDI), dashboards configuráveis e automações | Apoio ao PQTA, sem declarar certificação |
| 6 | Três rodadas completas sobre todos os módulos, revisão de segurança (ASVS), validação jurídica, homologação e publicação controlada | — |
