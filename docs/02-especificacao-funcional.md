# Especificação funcional — Fases 1 e 2 (implementadas)

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

## Pendentes nas Fases 1–2
Checklists digitais de admissão e desligamento (uniformes, equipamentos, termos), fluxo de solicitação de férias pelo funcionário, plantões e sobreaviso RCPN (Fase 2b), avaliações e treinamentos (Fase 5).
