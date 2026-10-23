# ADR 0015 — Treinamentos, avaliações de desempenho, painel configurável e automações

**Situação:** aceita (Fase 5b, 23/10/2026).

## Treinamentos
- **Catálogo** com público obrigatório (todos, setores ou cargos), carga horária, reciclagem (validade em meses) e avaliação de aprendizagem opcional (múltipla escolha, nota mínima e limite de tentativas; a alternativa correta nunca é enviada à tela).
- **Situação por pessoa** calculada da conclusão mais recente: válido, a vencer, vencido, pendente, em andamento — e, para **estudo de POP**, *nova versão* quando o documento vigente mudou depois da conclusão.
- **Estudo de POP** vinculado à versão: exige ciência da versão vigente (quando o documento pede ciência) e aprovação na avaliação feita depois da versão; o registro guarda a versão estudada.
- **Turmas** entram na agenda institucional; encerramento por lista de presença. Havendo avaliação, a presença confirmada conclui com a aprovação.
- **Segregação:** ninguém registra, valida ou anula o próprio treinamento; certificado autodeclarado é validado por outra pessoa do escopo (também no banco). Conclusões só podem ser **anuladas** com justificativa (gatilho).

## Avaliações de desempenho
- **Modelos versionados** (critérios por grupo, peso, escala, autoavaliação opcional). Publicado é imutável; alterar cria nova versão.
- **Programação automática** configurável (dias após a admissão — ex.: 30/60/90 — ou anual), criada com antecedência e atribuída à coordenação do setor (ou Substituta/Oficial). Prazos do período de experiência são definidos pela serventia; o sistema **não altera contratos**. A Oficial (titular) fica fora da programação automática.
- **Avaliador nunca é o avaliado** (gatilho); o avaliado não vê o rascunho; a autoavaliação só aparece ao avaliador depois de entregue.
- **Envio congela o conteúdo** em versão com hash (documento `AVALIACAO`); notas ficam bloqueadas (gatilho). Retificação gera nova versão; a anterior permanece no histórico.
- **Ciência sem concordância obrigatória:** o avaliado registra ciência (declaração expressa de que ciência não implica concordância), concordância ou discordância motivada — assinatura eletrônica simples com reautenticação. Sem manifestação no prazo configurado, o avaliador encerra registrando o motivo.
- **PDI** (com treinamento recomendado → inscrição) e **feedbacks documentados** com ciência do avaliado; histórico por pessoa.
- **Nenhum efeito automático:** a nota não gera efetivação, desligamento, promoção, remuneração ou desconto.

## Painel configurável
Cada pessoa escolhe e ordena blocos de um catálogo fixo; cada bloco só é oferecido e só mostra o que as permissões já permitem.

## Automações
Regras “quando <gatilho> há N dias → então <ação>” sobre catálogos **fixos**: gatilhos (tarefa atrasada, treinamento vencendo, avaliação atrasada, NC sem ação, incidente aberto, revisão de documento vencida, despesa vencida) e ações **seguras** (avisar responsável, papel ou pessoa; criar tarefa; aviso no Chat). Nenhuma automação altera, aprova, paga ou exclui. Cada item dispara uma vez por regra (`automation_runs`), no máximo 50 por execução; avisos a terceiros levam só o link (que respeita as permissões), não os detalhes.
