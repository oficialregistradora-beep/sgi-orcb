# Rodada 3 — Simulação operacional de seis meses

**Cenário:** 9 pessoas fictícias (Oficial, Substituta e 7 colaboradores com perfis pontual, extras, atrasos e esquecido), de 15/04/2026 a 21/10/2026, incluindo feriados nacionais, férias de 15 dias e atestado lançados pelo fluxo real, admissão no meio do período (serviço de admissão + acordo) e desligamento no meio do período (revogação de acesso).

**Ciclo mensal executado pelos serviços reais:** correções solicitadas pelo funcionário e aprovadas pela coordenação → justificativas → decisões da Substituta em ordem cronológica → espelho gerado, com ciência ou contestação do titular e aprovação da Oficial → fechamento da competência. Depois: compensação futura aprovada e pagamento de todos os créditos vencidos.

**Métricas** (`rodada3-metricas.json`): 837 dias úteis simulados; 66 dias com extra; 24 atrasos; 9 esquecimentos; 9 faltas integrais; 6 correções aprovadas; 12 justificativas; 59 créditos no banco; 12 abonos; 9 faltas não justificadas (sem desconto automático); 30 espelhos com ciência e 2 contestados (todos aprovados após análise); 6 competências fechadas; 81 min de créditos vencidos pagos; 32 versões de documento verificadas.

**Invariantes verificadas (todas aprovadas):**
1. O saldo de cada funcionário é igual ao recálculo independente (créditos decididos − coberturas − compensações − pagamentos).
2. Nenhum lote de crédito foi consumido além do seu valor.
3. Todo crédito corresponde a exatamente uma hora extra decidida para o banco, com o mesmo valor e vencimento de 6 meses.
4. Nenhuma ocorrência pendente em competência fechada.
5. Nada é apurado após a data de desligamento; o usuário desligado está revogado.
6. Todas as assinaturas e conteúdos conferem com seus hashes; trilha de auditoria íntegra.
7. Perfis distintos: colaborador não alcança dados de outro.

**Aceite humano:** pendente (roteiro em `docs/15-plano-de-testes.md`).
