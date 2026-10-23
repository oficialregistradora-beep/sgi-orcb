# Manual do administrador (Oficial Registradora e delegados)

## Primeiros passos
1. **Configurações → Setores e cargos**: ajustar a estrutura (os cinco setores iniciais já existem).
2. **Configurações → Jornadas**: conferir a jornada padrão 08–12/13–17 e criar jornadas individuais. A tolerância do art. 58 §1º vem ligada por padrão (pendente de validação jurídica).
3. **Configurações → Feriados**: incluir feriados estaduais e municipais de Capivari de Baixo (os nacionais de 2026–2027 já constam).
4. **Equipe → Admitir funcionário**: matrícula, cargo, setor, jornada e e-mail institucional (cria o acesso de Colaborador).
5. Na ficha do funcionário: cadastrar o **acordo de banco de horas** com a referência do instrumento assinado, os dados sensíveis e o salário (reautenticação exigida).
6. **Usuários e permissões**: atribuir *Substituta Legal* e *Coordenação de setor* (com setor coordenado). Para substituições temporárias, informar a data final.

## Rotina mensal sugerida
1. Diariamente ou semanalmente: **Ocorrências** — decidir horas extras (banco ou pagamento) e diferenças (abono, compensação com banco ou falta não justificada, com fundamentação).
2. **Solicitações → Para decidir**: correções, compensações e autorizações prévias.
3. Após o fim do mês: cada funcionário gera e assina o espelho e o extrato (**Meus documentos**); a gestão aprova em **Aguardando aprovação**. Contestações exigem análise escrita.
4. **Relatórios**: exportar o CSV para a contabilidade.
5. **Configurações → Competências**: fechar o mês (exige zero pendências). A reabertura exige motivo.
6. **Banco de horas** de cada funcionário: verificar créditos a vencer e vencidos; registrar pagamentos em folha.

## Segurança
- Perda de celular: **Usuários → selecionar → Redefinir autenticador**.
- Afastamento ou desligamento: suspender o usuário ou registrar o desligamento (revoga sessões na hora).
- Mensalmente: **Auditoria → Verificar integridade da cadeia**. Qualquer alerta aciona o plano de resposta a incidentes.
- Parâmetros (inatividade, reautenticação, alertas, divisor e adicional) ficam em **Configurações → Parâmetros**.

## Fase 2c — rotinas novas
- **Férias:** antes de aprovar, abra *Férias* do funcionário → *Conferência das faltas do período aquisitivo*. Faltas integrais ainda sem decisão bloqueiam a conferência; decida-as antes em *Ocorrências*. A conferência registra a faixa do art. 130 e a memória de cálculo.
- **Regras jurídicas** (*Configurações → Regras jurídicas*): após a leitura da CCT vigente, cadastre cada regra com fundamento e fonte. Ao registrar a validação (nome e OAB do responsável), a regra passa a valer. Regras históricas nunca valem.
- **Modelos de checklist** (*Configurações → Modelos de checklist*): *Editar (nova versão)* → ajustar itens → *Publicar*. Checklists já abertos não mudam.
- **Plantões:** se o substituto atendeu, troque o responsável antes de fechar. O sistema avisa quando há chamado registrado pelo substituto.

## Fase 3 — gestão documental
- **Categorias** (*Gestão documental → Categorias*): ajuste a revisão periódica e, após definir a tabela de temporalidade, o prazo de retenção **com o fundamento**. Sem prazo, o descarte permanece bloqueado.
- **Aprovações:** *Gestão documental → Aprovações* lista as versões que você pode decidir (as que você elaborou ou submeteu não aparecem).
- **Revisões:** *Gestão documental → Revisões* mostra revisões vencidas ou próximas; o responsável recebe aviso automático uma vez por data.
- **Confidenciais:** indique nominalmente as pessoas. A Substituta Legal, mesmo com gestão documental, só vê o documento se estiver na lista.
- **Cobertura de ciência:** no documento, quadro *Ciência da versão N*.
- **Rotina diária opcional:** o agendador (`/api/cron/processar`) também envia os avisos de revisão.

## Fase 4a — tarefas, projetos, rotinas e processos
- **Rotinas** (*Rotinas e processos → Rotinas recorrentes*): cadastre as atividades fixas (ex.: centrais 4×/dia com horários 09:00, 11:00, 14:00, 16:00; notificações e matrículas eletrônicas com bloco 16:00–17:00). As tarefas aparecem sozinhas a cada dia.
- **Processos** (*Modelos de processo*): uma etapa por linha (título | prazo | papel | aprovação s/n | documentos). Ao iniciar, as etapas viram tarefas em sequência.
- **Encaminhamentos:** questões ordinárias chegam à Substituta Legal; complexas, à Oficial. Registre a decisão na própria tarefa.
- **Projetos:** sugestões do planejamento (POPs, PQTA 2027, Segurança da Informação…) aparecem ao digitar o nome.

## Fase 4b — financeiro gerencial
- **Antes de usar:** cadastre centros de custo e fornecedores; ajuste categorias; registre o orçamento do ano (*Orçamento*).
- **Três pessoas:** quem solicita não aprova; quem solicita ou aprova não paga. Designe uma pessoa para *Registrar pagamentos* (papel próprio, criado em *Usuários e permissões*), diferente de quem aprova. O painel avisa quando uma despesa aprovada não tem quem a pague.
- **Limite de aprovação** (*Configurações → Parâmetros*, `financeiro.limite_aprovacao_delegada`): acima do valor, só a Oficial aprova. Padrão: desativado.
- **Mensalidades:** em *Contratos → Lançar despesas fixas do mês*, uma vez por mês (não duplica). Elas seguem para aprovação.
- **Pagamento:** anexe o comprovante e registre data, valor (igual ao aprovado) e forma. O registro é definitivo.
- **Receitas:** lançamento gerencial para o fluxo de caixa; correções por estorno.
- O módulo é gerencial e não substitui a escrituração nem o Livro Diário Auxiliar.

## Fase 5a — qualidade e segurança da informação
- **Requisitos** (*Qualidade e segurança → Requisitos*): cadastre cada requisito a partir da fonte oficial (indique a norma/item consultado); defina responsável e periodicidade de revisão. Nada vem pré-carregado — os do ambiente de homologação são exemplos.
- **Auditorias:** planeje com um auditor líder de fora do setor auditado, importe os requisitos de uma área e/ou escreva as perguntas. Inicie, avalie cada item com evidência objetiva e conclua — a auditoria fica imutável e atualiza os requisitos.
- **Não conformidades:** o responsável registra a causa raiz e cria ações (viram tarefas); ao concluir, encaminha para verificação de eficácia, feita por outra pessoa.
- **Riscos:** probabilidade e impacto de 1 a 5, controles e risco residual; reavalie na periodicidade. Aceitar risco alto/crítico é decisão da Oficial.
- **Incidentes:** trate (contenção, causa raiz), registre a avaliação LGPD quando houver dados pessoais e encerre.
- **Ativos, backups e vulnerabilidades:** mantenha o inventário (inclua certificados digitais e licenças com validade), registre backups e testes de restauração e as vulnerabilidades. Ajuste os prazos em *Configurações* (chaves `seguranca.*`).

## Fase 4c — agenda e integrações Google
- **Agenda** (menu): cadastre reuniões, prazos e treinamentos; marque “Avisar no Google Chat” quando quiser anunciar.
- **Integrações** (*Configurações → Integrações*): depois de configurar as credenciais (guia docs/23, Parte C), ative cada canal. Comece pela Agenda com plantões, marcos e eventos; ative férias somente após avaliação do encarregado de dados.
- **Erros:** a tela mostra os últimos erros; use *Reenviar mensagens com falha* depois de corrigir a configuração.
- **Agendamento:** rotina diária (`/api/cron/processar`) e, para e-mails rápidos, `?somente=integracoes` a cada 10 minutos.
