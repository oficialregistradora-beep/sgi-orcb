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
