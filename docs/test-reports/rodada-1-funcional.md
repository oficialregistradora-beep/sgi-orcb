# Rodada 1 — Testes funcionais (30 casos de integração + 54 unitários)

Cobertura por módulo (entradas válidas, inválidas e excepcionais):
- **Sessões:** validade, revogação imediata ao suspender, inatividade de 31 min, expiração absoluta, token inexistente.
- **MFA:** segredo cifrado no banco, código inválido, ativação, recusa de reuso, janela de ±1 passo, bloqueio após 5 falhas (auditado).
- **Login Google:** domínio, e-mail não verificado, nonce, conta não cadastrada (negada e auditada), vínculo do `sub` no primeiro acesso, outro `sub` não sequestra a conta.
- **Administração:** domínio institucional obrigatório, duplicidade, reautenticação exigida, papel com vigência (concede e expira), matriz configurável, papel da Oficial protegido, permissão global só em TODOS.
- **Admissão:** transação completa, matrícula duplicada, e-mail externo, colaborador sem permissão.
- **Marcação:** horário do servidor, duplicidade em 60 s, usuário sem vínculo funcional.
- **Apuração:** ocorrências exatas do cenário semanal, tolerância aplicada, reprocessamento idempotente, justificativa apenas pelo titular.
- **Banco:** crédito com vencimento de 6 meses, consumo PEPS, resolução incompatível recusada, sem acordo → banco recusado, falta não justificada sem lançamento e com fundamentação obrigatória.
- **Correções:** original preservado, ocorrência incompleta superada, estorno automático após correção posterior, data futura recusada.
- **Compensações:** débito PEPS, saldo insuficiente recusado, exigência de acordo e de dia com jornada, permissão da coordenação insuficiente.
- **Autorização prévia:** extra resolvida automaticamente no destino autorizado.
- **Vencimento e pagamento:** crédito vencido permanece visível; pagamento só com permissão, sem exceder os créditos.
- **Espelho:** versão reaproveitada, ressalva legal, dupla conferência, titular não aprova, terceiros não dão ciência, reautenticação, manifestações incompatíveis, contestação com motivo, aprovação de contestado exige análise, verificação de hashes.
- **Fechamento:** bloqueio de correções, reabertura auditada.

Unitários: 22 casos de apuração (incluindo Súmula 366 e cada alerta), 15 de banco de horas (vencimentos em fim de mês e ano bissexto, PEPS, estornos, custo em centavos), 17 de primitivas de segurança (GCM com detecção de adulteração, HMAC, JSON canônico, CPF, vetores RFC 6238, fuso, limitação de taxa, configuração segura).
