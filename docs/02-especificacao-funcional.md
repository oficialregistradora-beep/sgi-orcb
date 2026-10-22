# Especificação funcional — Fases 1, 2 e 2b (implementadas)

## F1. Acesso
- F1.1 Login exclusivo com conta do domínio institucional. Somente usuários pré-cadastrados e ativos entram; tentativas negadas são auditadas.
- F1.2 Segundo fator TOTP obrigatório (cadastro por QR Code no primeiro acesso). Bloqueio de 15 min após 5 códigos inválidos; códigos não podem ser reutilizados.
- F1.3 Sessão expira por inatividade (30 min) e por limite absoluto (12 h); ambos são parâmetros. Suspensão, revogação, desligamento e redefinição de MFA encerram as sessões imediatamente.
- F1.4 Reautenticação (código TOTP) para: criar usuários, alterar papéis e permissões, alterar dados sensíveis e salário, cadastrar acordos, registrar pagamentos, fechar e reabrir competências, desligar funcionários, alterar parâmetros e assinar documentos.

## F2. Jornada (controle administrativo interno)
- F2.1 Marcação pelo próprio funcionário; o horário é **sempre o do servidor de banco**. Cliques repetidos em menos de 60 s são recusados.
- F2.2 Apuração diária: pares de marcações; jornada prevista pela jornada contratual vigente; feriados e ausências abonadas zeram a jornada prevista.
- F2.3 Tolerância (art. 58 §1º): desvios ≤ 5 min por marcação e ≤ 10 min no dia não são computados. Ultrapassado o limite, computa-se a totalidade (Súmula 366). Parametrizável por jornada.
- F2.4 Alertas (não bloqueiam): marcação ímpar, intervalo < 1 h em jornada > 6 h (com a tolerância por marcação), extra acima do limite diário do acordo, jornada > 10 h, trabalho em descanso ou feriado, interjornada < 11 h.
- F2.5 Ocorrências geradas para dias encerrados: HORA_EXTRA, DIFERENCA_NEGATIVA, MARCACAO_INCOMPLETA. Ficam **pendentes** até decisão humana.
- F2.6 Correções por solicitação (incluir marcação ou desconsiderar marcação). O original nunca é alterado. A aprovação reprocessa o dia; uma ocorrência já decidida que mude de valor é superada, e seu lançamento no banco é estornado automaticamente.

## F3. Banco de horas
- F3.1 Exige acordo cadastrado e vigente (individual escrito: até 6 meses; coletivo: até 12).
- F3.2 Hora extra → banco (crédito com vencimento = data + prazo do acordo, até o limite diário do acordo) ou pagamento. **Nunca é descartada.**
- F3.3 Diferença negativa → abono (fundamentado), cobertura com créditos (PEPS) ou "falta não justificada" (só sinaliza para a folha; **sem desconto automático**). Saldo negativo apenas se o acordo admitir.
- F3.4 Compensações (folga integral, parcial, entrada posterior, saída antecipada) por solicitação aprovada; consomem créditos PEPS válidos na data.
- F3.5 Autorização prévia de extra: quando aprovada antes do dia, a extra realizada (até o limite autorizado) é resolvida automaticamente no destino autorizado.
- F3.6 Créditos vencidos permanecem visíveis como "vencido — requer pagamento/análise"; o pagamento em folha é registrado e consome créditos.
- F3.7 Alertas: créditos a vencer (30 dias), saldo elevado (40 h), créditos vencidos. Custo estimado informativo, visível apenas com permissão específica.
- F3.8 Fechamento de competência (sem pendências) bloqueia correções e decisões retroativas. A reabertura é fundamentada e auditada.
- F3.9 Relatório mensal para a folha (tela e CSV protegido contra injeção de fórmulas).

## F4. Documentos e assinaturas
- F4.1 Espelho mensal e extrato do banco gerados a partir dos dados, como JSON canônico com hash SHA-256. Conteúdo igual reaproveita a versão; conteúdo diferente gera nova versão.
- F4.2 Manifestações distintas: ciência (não implica concordância), concordância, contestação (motivo obrigatório) e aprovação.
- F4.3 Dupla conferência: a aprovação só ocorre após a manifestação do titular; se houve contestação, a análise é obrigatória.
- F4.4 Evidências por assinatura: usuário, versão, hash, texto exato da declaração, data e hora, sessão, método de autenticação, horário do MFA e da reautenticação, IP, navegador e hash das evidências. Verificação independente disponível na tela.

## F5. Pessoas
Admissão (cadastro + usuário + papel básico + jornada + histórico, numa transação), edição com histórico de cargo e setor, dados sensíveis criptografados (cada consulta auditada), histórico salarial restrito, jornada contratual por vigência, acordos, férias, afastamentos e ausências, e desligamento (revoga acessos e sessões, encerra jornada e acordo, preserva registros e sinaliza o saldo para a rescisão).

## F6. Administração
Setores, cargos, jornadas, feriados, parâmetros, papéis, matriz de permissões, atribuições com vigência, usuários (criar, suspender, revogar, redefinir MFA) e auditoria com verificação da cadeia.

## F7. Plantões e sobreaviso RCPN (Fase 2b)
- F7.1 Escala de sábados, domingos e feriados (08h–18h, parametrizável), gerada em rodízio entre os participantes escolhidos. A geração pula férias e afastamentos, define substituto distinto do responsável e não sobrescreve plantões existentes. Também há plantão avulso.
- F7.2 Substituição e reatribuição com motivo (auditadas e notificadas). Cancelamento só sem chamados; plantões nunca são excluídos.
- F7.3 Registro de chamados pelo plantonista, pelo substituto ou pela gestão: horário do chamado, da resposta e do comparecimento, e descrição do serviço **sem dados pessoais dos usuários**. Registro equivocado é anulado com motivo e preservado.
- F7.4 Fechamento pela gestão (nunca pelo próprio plantonista): o **sobreaviso** (duração menos o efetivo dentro da janela) e o **trabalho efetivo** (união dos comparecimentos, inclusive após o horário) são congelados. O efetivo vai para o banco de horas (crédito único, com acordo vigente) ou para pagamento. Plantão fechado é imutável.
- F7.5 O dia de plantão do plantonista não gera hora extra na apuração comum (alerta "dia de plantão"), o que evita dupla contagem.
- F7.6 Relatório mensal com sobreaviso, efetivo no banco e efetivo pago em colunas **separadas**. Valores estimados (1/3 da hora no sobreaviso; adicional no efetivo pago) aparecem apenas com permissão de custos. Gratificações nunca compensam o sobreaviso automaticamente.
- Limitação: o efetivo é creditado ao responsável do plantão. Se o substituto atender, a gestão deve reatribuir antes do fechamento.

## F8. Férias (Fase 2b)
- F8.1 Períodos aquisitivo e concessivo calculados desde a admissão; saldo por período; situação (em aquisição, disponível, a vencer em 60 dias, vencidas — dobra do art. 137, quitado).
- F8.2 Pedido pelo funcionário com as regras do art. 134: mínimo de 5 dias; até 3 períodos, um deles com 14 dias ou mais; o terceiro período esgota o saldo; saldo restante não pode ficar entre 1 e 4 dias; início vedado nos 2 dias anteriores a domingo ou feriado; abono pecuniário de até 10 dias, uma vez por período. Só se usa período aquisitivo **completo**, sempre o mais antigo com saldo. Pedidos pendentes reservam saldo.
- F8.3 Avisos (não bloqueiam): comunicação com menos de 30 dias (art. 135), gozo após o período concessivo (dobra) e conferência manual de faltas do art. 130.
- F8.4 A aprovação (por quem tem `ferias.aprovar`, nunca o próprio funcionário) revalida tudo, lança a ausência abonada e registra o consumo do período. O cancelamento só é possível antes do início, e restitui o saldo.
- F8.5 Painel da equipe com programação e alertas de vencimento.

## F9. Checklists e itens entregues (Fase 2b)
- F9.1 A admissão e o desligamento abrem automaticamente checklists a partir de modelos, com prazos relativos à data do evento. Itens verificáveis são concluídos pelo sistema (jornada definida, acordo cadastrado, autenticador ativo, acessos revogados, itens devolvidos). "Não se aplica" exige justificativa.
- F9.2 Itens entregues (uniforme, equipamento, crachá, chave) geram um **termo de entrega** com hash para ciência eletrônica do funcionário. A devolução atualiza o checklist de desligamento.
- F9.3 A exigência da segunda etapa (aprovação) é configurável por tipo documental em Configurações → Parâmetros (`documentos.aprovacao.*`).

## Pendentes
Modelos de checklist editáveis pela interface (hoje vêm da migration), avaliações de desempenho e treinamentos (Fase 5), redução automática de férias pelo art. 130 (depende de J-13).
