# Roteiro de homologação (aceite pela serventia)

**Objetivo:** a Oficial e a Substituta (e, se desejado, uma coordenação e um colaborador) usam o sistema com **dados fictícios** e confirmam, por escrito, que ele atende ao que foi pedido. A homologação é humana: os testes automatizados não a substituem.

**Ambiente:** homologação (`APP_ENV=homologacao`), com o login de teste e a carga fictícia (`npm run db:seed`). Em homologação na nuvem (após P-02/P-03), o login é pela conta Google institucional.

**Como registrar:** para cada item, marque ✅ (aceito), ⚠️ (aceito com ajuste) ou ❌ (não aceito) e descreva o ajuste. Ao final, a Oficial registra o aceite (ou a lista de correções).

## 1. Acesso e segurança (Oficial)
- [ ] Entrar, cadastrar o autenticador e sair. Tentar abrir uma página interna sem sessão (deve pedir login).
- [ ] *Usuários e permissões*: conferir os papéis; criar um usuário fictício; suspender e confirmar o bloqueio imediato.
- [ ] *Auditoria*: verificar a cadeia de auditoria (deve estar íntegra).

## 2. Pessoas, jornada e banco de horas
- [ ] Admitir um funcionário fictício com jornada e acordo de banco de horas.
- [ ] Como funcionário: registrar 4 marcações; pedir correção de marcação; pedir compensação.
- [ ] Como coordenação: decidir as ocorrências (extra → banco; diferença → abono); aprovar a correção e a compensação.
- [ ] Gerar o espelho e o extrato do mês anterior; o funcionário registra ciência/concordância/contestação; a coordenação aprova; fechar a competência.
- [ ] Conferir a ressalva da Portaria MTP 671/2021 no espelho (controle administrativo, não REP).

## 3. Férias, plantões e checklists
- [ ] Solicitar e aprovar férias; conferir avisos (antecedência, períodos).
- [ ] Gerar a escala de plantões do RCPN; registrar chamado e encerramento; conferir sobreaviso × trabalho efetivo separados.
- [ ] Checklist de admissão: entregar uniforme/equipamento com termo assinado.

## 4. Gestão documental
- [ ] Criar um POP, aprovar (outra pessoa), publicar para um setor com ciência; o colaborador registra ciência; conferir o relatório de cobertura.
- [ ] Documento confidencial: confirmar que quem não está na lista não o vê.
- [ ] Enviar arquivo de teste com vírus (EICAR) e confirmar o bloqueio.

## 5. Tarefas, projetos, rotinas e processos
- [ ] Criar tarefa para outra pessoa, com aprovação; concluir e aprovar.
- [ ] Rotina diária (centrais eletrônicas 4×/dia) aparece em *Minhas tarefas*.
- [ ] Projeto com fases, marcos e Gantt; processo de admissão com etapas.

## 6. Financeiro gerencial
- [ ] Solicitar despesa (coordenação), aprovar (Substituta) e pagar com comprovante (terceira pessoa).
- [ ] Compra com cotações; contrato com lançamento mensal; orçamento previsto × realizado; relatório CSV.
- [ ] Conferir o aviso de que o módulo não substitui a escrituração nem o Livro Diário Auxiliar.

## 7. Agenda e integrações Google (após P-03)
- [ ] Cadastrar evento institucional; ativar a Agenda (plantões e marcos) e conferir no Google Agenda.
- [ ] Ativar e-mail (Gmail) e Chat; conferir que o conteúdo sensível não é enviado.

## 8. Qualidade e segurança da informação
- [ ] Cadastrar um requisito real com a fonte; registrar evidência e avaliar.
- [ ] Planejar e executar uma auditoria interna; conferir a NC aberta automaticamente, a ação como tarefa e a verificação de eficácia por outra pessoa.
- [ ] Comunicar incidente (como colaborador) e tratar até o encerramento (com avaliação LGPD).
- [ ] Riscos, ativos (certificado digital com validade), backups e vulnerabilidades.

## 9. Treinamentos e avaliações
- [ ] Cadastrar treinamento obrigatório com reciclagem; criar turma, encerrar com presença; validar certificado externo.
- [ ] Estudo de POP com avaliação de aprendizagem.
- [ ] Publicar modelo de avaliação; programar 30/60/90 dias; preencher, enviar; o avaliado registra ciência ou discordância.

## 10. Painel e automações
- [ ] Personalizar o painel; criar uma automação de aviso e executá-la.

## Aceite
Local e data: ____________________ · Oficial Registradora: ____________________

Observações / correções solicitadas:
