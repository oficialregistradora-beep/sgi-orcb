# Plano de implantação gradual

| Etapa | Ação | Responsável | Pré-requisito |
|---|---|---|---|
| 0 | Decisões P-01 a P-06 (edição do Workspace, infraestrutura, OAuth, CCT, jurídico, encarregado) | Oficial | — |
| 1 | Validação jurídica dos itens J-01 a J-17 e ajuste de parâmetros | Advogado(a) trabalhista | Etapa 0 |
| 2 | Provisionar o ambiente de **homologação** no GCP (dados fictícios) | Dev/DevOps | P-02, P-03 |
| 3 | Homologação guiada pela Oficial e pela Substituta (roteiro: `25-roteiro-homologacao.md`) | Serventia | Etapa 2 |
| 4 | Treinamento da equipe (1 h; manual do funcionário) e cadastro dos autenticadores | Oficial + Dev | Etapa 3 |
| 5 | Provisionar **produção**; cadastrar a Oficial; cadastros funcionais reais pela interface, com **início do controle** = data da implantação e **férias anteriores** lançadas por período (manual do administrador, Primeiros passos, item 4); banco de horas anterior quitado; **despesas fixas mensais** importadas da planilha do último mês fechado (Financeiro → Contratos → Despesas fixas mensais → Importar) e revisadas | Oficial | Aceite formal |
| 6 | Operação paralela por 1 mês (controle atual + SGI), conferindo espelhos | Serventia | Etapa 5 |
| 7 | Encerrar o controle anterior; primeiro fechamento de competência no SGI | Oficial | Divergências resolvidas |

Lista de verificação completa: [26-checklist-producao.md](26-checklist-producao.md). Publicação em produção **somente com autorização expressa** da Oficial Registradora. Nenhuma implantação foi realizada até esta data.
