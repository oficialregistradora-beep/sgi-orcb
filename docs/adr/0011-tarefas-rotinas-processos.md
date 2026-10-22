# ADR 0011 — Tarefas, projetos, rotinas e processos

**Situação:** aceita (Fase 4a, 22/10/2026).

- **Modelo único de tarefa** para tarefas avulsas, de projeto, subtarefas, ocorrências de rotina e etapas de processo. Lista, quadro (Kanban), calendário, Gantt e painel são visões da mesma tabela.
- **Nada se exclui:** tarefas e projetos são cancelados (com motivo); comentários, anexos, histórico e custos são imutáveis (gatilhos no banco).
- **Rotinas** geram tarefas de forma **idempotente** (chave única rotina + data/horário), na rotina diária e ao abrir as telas — sem processo agendado obrigatório. Ocorrência mensal/anual em dia não útil é adiada ao próximo dia útil. Ex.: verificação das centrais eletrônicas 4×/dia; bloco 16–17 h para notificações e matrículas eletrônicas; prioridade **Imediata** para conferências e averbações designadas.
- **Processos:** o modelo é copiado para a instância ao iniciar (alterações posteriores no modelo não afetam execuções em curso). Cada etapa vira tarefa dependente da anterior; a instância encerra sozinha quando todas as etapas terminam. Responsável por papel só é atribuído quando há exatamente uma pessoa com o papel; senão, a etapa fica para o setor.
- **Aprovação com segregação:** quem executou ou é responsável não aprova (verificado no serviço e por CHECK no banco). Etapa de processo com aprovação: aprovador = quem iniciou (ou a Oficial, se quem iniciou for o responsável).
- **Escalonamento:** questões ordinárias → Substituta Legal vigente; complexas → Oficial; a decisão é registrada como comentário imutável.
- **Acesso:** próprio (responsável, autor, aprovador, destinatário de encaminhamento), setor (permissões com escopo), projeto (gestor, membro, leitor). Sem acesso, a resposta é "não encontrada".
- **Limites:** o módulo organiza atividades internas; **não** qualifica títulos, **não** pratica atos e **não** substitui livros, protocolos, centrais ou sistemas oficiais. Gantt e quadro são renderizados no servidor, sem bibliotecas externas e sem arrastar-e-soltar (mudança de situação por botões).
