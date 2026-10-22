# Matriz de permissões (configuração inicial)

Configurável em **Usuários e permissões → Matriz** sem alterar código. A Oficial (`is_owner`) possui todas as permissões. Escopos: **T** todos · **S** setor coordenado (ou de lotação) · **P** próprio · — nenhum.

| Permissão | Oficial | Substituta Legal | Coordenação de setor | Colaborador |
|---|:-:|:-:|:-:|:-:|
| usuarios.gerenciar ★ | T | — | — | — |
| permissoes.gerenciar ★ | T | — | — | — |
| auditoria.ver ★ | T | — | — | — |
| configuracoes.gerenciar | T | T | — | — |
| pessoas.ver | T | T | S | P |
| pessoas.editar | T | T | — | — |
| pessoas.sensiveis.ver / editar ★ | T | — | — | — |
| pessoas.salario.ver / editar ★ | T | — | — | — |
| jornada.registrar | T | T | — | P |
| jornada.ver | T | T | S | P |
| jornada.ausencias.gerenciar | T | T | — | — |
| jornada.escalas.gerenciar | T | T | — | — |
| solicitacoes.criar | T | T | — | P |
| solicitacoes.correcao.aprovar | T | T | S | — |
| solicitacoes.compensacao.aprovar | T | T | — | — |
| solicitacoes.extra.aprovar | T | T | S | — |
| banco.ver | T | T | S | P |
| banco.ocorrencias.tratar | T | T | — | — |
| banco.acordos.gerenciar ★ | T | — | — | — |
| banco.pagamentos.registrar ★ | T | — | — | — |
| banco.periodo.fechar ★ | T | — | — | — |
| banco.custos.ver ★ | T | — | — | — |
| espelho.aprovar | T | T | S | — |
| plantoes.ver | T | T | S | P (responsável ou substituto) |
| plantoes.registrar | T | T | — | P |
| plantoes.gerenciar | T | T | — | — |
| plantoes.fechar | T | T | — | — |
| ferias.ver | T | T | S | P |
| ferias.aprovar (inclui a conferência de faltas) | T | T | — | — |
| regras.juridicas.gerenciar ★ | T | — | — | — |
| checklists.modelos.editar | T | T | — | — |
| checklists.modelos.publicar ★ | T | — | — | — |
| documentos.ver | T | T | T | T |
| documentos.editar | T | T | S | — |
| documentos.aprovar | T | T | — | — |
| documentos.gerenciar ★ | T | T | — | — |
| documentos.descartar ★ | T | — | — | — |
| tarefas.ver | T | T | S | P (atribuídas, criadas, de projetos em que participa) |
| tarefas.criar | T | T | S | P (para si, no próprio setor) |
| tarefas.gerenciar | T | T | S | — |
| projetos.gerenciar | T | T | S | — |
| rotinas.gerenciar | T | T | — | — |

★ permissão sensível. Papéis se acumulam: a Escrevente Substituta recebe *Coordenação de setor* e *Colaborador*.

**Regras adicionais (codificadas, não configuráveis):** ninguém decide a própria solicitação nem analisa a própria ocorrência; ninguém atribui papel a si mesmo; o funcionário não aprova o próprio espelho; a aprovação de espelho exige a manifestação prévia do titular (dupla conferência); operações ★ e assinaturas exigem reautenticação. A Oficial pode decidir pedidos próprios, e isso fica registrado expressamente na auditoria.

**Documentos (Fase 3):** `documentos.ver` dá acesso apenas aos documentos **vigentes** cujo público inclui a pessoa. Quem elaborou ou submeteu uma versão não a aprova — **nem a Oficial**. Documento **confidencial** só é visto pela Oficial, pelo responsável, pelo autor e pelas pessoas da lista; as permissões de gestão, edição e aprovação não o alcançam sem inclusão na lista. Aprovação, ciência e descarte exigem reautenticação.
