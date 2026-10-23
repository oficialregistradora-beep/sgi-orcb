# ADR 0014 — Qualidade, riscos e segurança da informação

**Situação:** aceita (Fase 5a, 23/10/2026).

## Contexto
A serventia quer apoio à gestão da qualidade — inclusive à preparação para o PQTA — e controles de segurança da informação (incidentes, ativos, backups, vulnerabilidades). O sistema não pode afirmar conformidade nem certificação, nem presumir requisitos normativos.

## Decisões
- **Nenhum requisito pré-carregado.** A serventia cadastra cada requisito com a **fonte consultada** (norma, item, regulamento vigente do PQTA). Os requisitos do seed são *exemplos fictícios* identificados como tal. Avaliar como *atendido* exige ao menos uma evidência (documento vigente do repositório ou arquivo verificado pelo antivírus); *parcial*, *não atendido* e *não aplicável* exigem justificativa. Todas as avaliações ficam em histórico imutável.
- **Índice de atendimento** = (atendidos + ½ parciais) ÷ aplicáveis; não avaliados contam como não atendidos. É indicador interno do que foi registrado — a tela diz isso expressamente.
- **Auditoria interna** com checklist (perguntas livres e/ou requisitos de uma área). **Independência:** o auditor líder e quem avalia itens não podem pertencer ao setor auditado (exceto a Oficial). Item *não conforme* abre a não conformidade automaticamente; *observação* não é não conformidade e conta como atendido no requisito, com a observação no histórico. Auditoria concluída é **imutável** (gatilho no banco).
- **Não conformidades e ações:** cada ação (correção imediata, corretiva, preventiva, melhoria) é uma **tarefa** do módulo de tarefas — prazos, lembretes, evidências e aprovação reaproveitados, sem um segundo sistema de ações. Encaminhar para verificação exige causa raiz e ações encerradas. **Verificação de eficácia por pessoa diferente do responsável** (serviço + CHECK no banco); ineficaz volta ao tratamento.
- **Riscos:** matriz 5×5 (probabilidade × impacto), faixas internas ajustáveis (1–4, 5–9, 10–16, 20–25), risco residual, revisão periódica com histórico. **Aceitar risco alto ou crítico — e vulnerabilidade alta ou crítica — é decisão da Oficial.**
- **Incidentes:** qualquer colaborador comunica (permissão `incidentes.registrar`); os gestores recebem aviso **sem a descrição** (pode conter dados pessoais). O colaborador vê apenas o que comunicou. Encerramento exige contenção, causa raiz, ações concluídas e, havendo dados pessoais, a **avaliação LGPD registrada** (CHECK no banco). O sistema **não decide** se a comunicação à ANPD/titulares é obrigatória: registra a avaliação de quem tem a responsabilidade (controlador, com o encarregado — P-06).
- **Ativos, backups e vulnerabilidades:** inventário com histórico de movimentações e baixa justificada (bloqueada com vulnerabilidade em aberto); registros de backup e de teste de restauração imutáveis, com situação por sistema; prazos de correção de vulnerabilidades por severidade como **política interna configurável** (7/30/90/180 dias iniciais), não exigência normativa.
- **Lembretes** (rotina diária): reavaliação de requisitos e riscos, auditoria próxima, vulnerabilidade a vencer/vencida, garantia/licença/certificado a vencer, teste de restauração em atraso — cada um enviado **uma única vez** por chave (`reminder_log`, seguro sob execução concorrente).
- **Numeração** legível por tipo e ano (NC-2026-001, INC-…, AUD-…, RSC-…) em contador transacional.

## Consequências
- Sem requisitos cadastrados a partir das fontes oficiais, o painel de conformidade não tem significado — é tarefa da serventia (J-17).
- Em equipe pequena, a independência da auditoria e a segregação da eficácia podem exigir a Oficial ou a Substituta como auditoras/verificadoras.
