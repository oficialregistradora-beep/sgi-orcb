# Manual completo do SGI — Ofício de Registros de Capivari de Baixo/SC

> Manual de uso do **SGI (Sistema de Gestão Interna)** para todas as pessoas da serventia.
> Versão do sistema: produção publicada em 29/10/2026.
> Endereço: **https://sgi-orcb-416495482761.southamerica-east1.run.app**
> Este manual não contém dados pessoais, senhas nem chaves. Nunca envie códigos do autenticador, senhas ou dados de colegas a ninguém, nem a um assistente.

## Sumário
1. O que é o SGI
2. Primeiro acesso e entrada no sistema
3. A tela do sistema e quem vê o quê
4. Para todos: ponto, banco de horas, documentos, férias, tarefas e outros
5. Para a gestão (Coordenação, Substituta Legal e Oficial)
6. Financeiro gerencial
7. Qualidade e segurança da informação
8. Treinamentos e avaliações de desempenho
9. Administração (Configurações, Usuários e permissões, Auditoria, Automações, Rede, Convenção coletiva e acordos individuais)
10. Rotinas recomendadas (diária, mensal, anual)
11. Problemas comuns e soluções
12. Limites legais e cuidados
13. Glossário

---

## 1. O que é o SGI

O SGI reúne num só lugar a gestão interna da serventia:
- **Pessoas e jornada:** marcação de ponto, ocorrências, banco de horas, espelho mensal, férias, plantões do RCPN e checklists de admissão e desligamento.
- **Gestão documental:** POPs, normas internas e comunicados, com versões, aprovação e ciência.
- **Tarefas, projetos, rotinas e processos.**
- **Financeiro gerencial:** despesas, compras, contratos, despesas fixas, orçamento, receitas e o relatório para o Asgard.
- **Qualidade e segurança da informação:** requisitos, auditorias internas, não conformidades, riscos, incidentes, ativos, backups e vulnerabilidades.
- **Treinamentos e avaliações de desempenho**, com plano de desenvolvimento (PDI).
- **Agenda, notificações e painel.**

Princípios:
- Cada pessoa vê **somente o que o papel dela permite**.
- **Tudo fica registrado na auditoria:** quem fez, o quê e quando.
- **Registros importantes não são apagados.** Marcações, pagamentos e manifestações são corrigidos por novo registro (correção, estorno, nova versão), e o original é preservado.
- **Operações críticas pedem de novo o código do autenticador** (reautenticação), que vale 10 minutos.

---

## 2. Primeiro acesso e entrada no sistema

### 2.1 Do que você precisa
- A sua **conta Google institucional** (@registroscapivari.com). Contas pessoais (@gmail.com) não entram.
- Um **aplicativo autenticador** no celular: Google Authenticator, Microsoft Authenticator ou similar.
- Estar **na rede do cartório**, se a restrição de rede estiver ativa (ver 2.5).

### 2.2 Primeiro acesso
1. Abra o endereço do sistema e clique em **Entrar com Google**.
2. Escolha a sua conta @registroscapivari.com.
3. O sistema mostra um **QR code**. No aplicativo autenticador, toque em **+** (adicionar conta) e leia o QR code.
4. Digite o **código de 6 dígitos** que aparece no aplicativo.
5. Pronto: você está no **Painel**.

Dica: no aplicativo autenticador, dê à conta um nome fácil de reconhecer, como "SGI PRODUÇÃO". Se você participou da homologação, terá uma conta antiga com o mesmo nome. Os códigos dela **não** funcionam na produção, então apague-a ou renomeie-a para "SGI homologação (antigo)".

### 2.3 Acessos seguintes
**Entrar com Google** → digitar o código atual do aplicativo.

### 2.4 Sessão, bloqueio e saída
- Depois de **30 minutos sem uso**, a sessão expira e é preciso entrar de novo.
- Uma sessão dura no máximo **12 horas**.
- Para sair, clique em **Sair**, no canto superior direito. Faça isso sempre em computador compartilhado.
- Algumas operações pedem o código do autenticador de novo, por exemplo: alterar permissões, aprovar documentos, registrar manifestação no espelho, dados sensíveis, salário e configurações de rede. Essa confirmação vale **10 minutos**.
- **Cada código só pode ser usado uma vez.** Se o sistema recusar um código recém-usado, espere o próximo (eles mudam a cada 30 segundos).

### 2.5 Restrição à rede da serventia
O sistema só pode ser usado **na internet do cartório**. Fora dela, aparece a mensagem "Acesso permitido apenas na rede da serventia", e a tentativa fica registrada.
- **Celular no 4G/5G conta como fora.** Dentro do cartório, ligue o Wi-Fi da serventia.
- **A marcação de ponto só é aceita na rede do cartório.**
- **Podem acessar de fora:**
  - a Oficial;
  - quem tem a permissão **Acesso externo** (por padrão, a Substituta Legal);
  - quem recebeu uma **liberação temporária** (até 31 dias, com motivo);
  - o **plantonista do RCPN** durante o plantão, com uma folga antes e depois.

### 2.6 Troquei ou perdi o celular
Avise a Oficial ou a Substituta. Elas abrem **Usuários e permissões** → selecionam você → **Redefinir autenticador**. No próximo acesso, você lê um QR code novo. Se o celular foi **perdido ou roubado**, comunique também um **incidente** (ver 7.6).

---

## 3. A tela do sistema e quem vê o quê

### 3.1 Partes da tela
- **Menu à esquerda**, em três grupos:
  - **Pessoal:** Painel, Minha jornada, Banco de horas, Meus documentos, Solicitações, Gestão documental, Agenda, Férias e Plantões RCPN.
  - **Gestão:** Ocorrências, Equipe, Relatórios, Tarefas, Projetos, Rotinas e processos, Financeiro, Qualidade e segurança (ou Comunicar incidente), Treinamentos e Avaliações e PDI.
  - **Administração:** Configurações, Usuários e permissões, Auditoria e Automações.
- **Sino (Notificações)**, no alto: avisos internos, com o número de não lidos.
- **Seu nome**, no canto superior direito, e o botão **Sair**.
- O rodapé do menu mostra o ambiente (**Produção**). Se aparecer uma faixa amarela "Ambiente de homologação — somente dados fictícios", você está no endereço **errado**: não cadastre nada real ali.

**Se um item não aparece no menu, é porque o seu papel não dá acesso a ele.** Isso é normal e não é erro.

### 3.2 Papéis
| Papel | Para quem | O que pode, em resumo |
|---|---|---|
| **Colaborador** | todo funcionário (dado automaticamente na admissão) | os **próprios** dados: ponto, banco de horas, espelho, solicitações e férias. Também: plantões, documentos institucionais, tarefas, treinamentos, avaliações e comunicar incidente |
| **Coordenação de setor** | quem coordena um setor (RI, RCPN, Atendimento…) | o mesmo do Colaborador, mais a visão da **equipe do setor**: ver pessoas, jornada e banco; aprovar correções de ponto, horas extras e espelhos do setor; editar documentos; tarefas e projetos; solicitar despesas; registrar treinamentos e avaliar |
| **Substituta Legal** | substituta designada | gestão de pessoal e jornada de **todos**: equipe, ocorrências, solicitações, espelhos, férias, plantões, documentos (inclusive aprovar), tarefas, rotinas, financeiro (solicitar, aprovar, pagar, cadastros), qualidade, treinamentos, avaliações, automações, configurações e acesso externo. **Não** vê dados sensíveis nem salário e **não** administra usuários e permissões |
| **Oficial Registradora** | a titular | **tudo**, inclusive usuários e permissões, auditoria, dados sensíveis, salários e decisões reservadas |

Outros papéis podem ser criados em **Usuários e permissões**, por exemplo um papel só para registrar pagamentos. Um papel pode ter **data de fim**, para substituições temporárias.

### 3.3 Painel
É a primeira tela. Mostra o que você está autorizado a ver: sua situação do dia, minhas tarefas, meus treinamentos, próximas ausências e, para a gestão, frequência de hoje, alertas de jornada, banco de horas por funcionário e visão da administração.
- **Personalizar painel:** escolha e ordene os quadros que quer ver.

### 3.4 Notificações
O **sino** reúne os avisos, por exemplo: solicitação decidida, tarefa atribuída, documento para ciência, férias a vencer, despesa para aprovar e acessos recusados a partir de um endereço novo (possível troca do IP do cartório). Clique no aviso para ir direto ao assunto.

---

## 4. Para todos os funcionários

### 4.1 Minha jornada (marcação de ponto)
- Menu **Minha jornada** → o botão principal mostra a próxima marcação esperada: **Registrar entrada**, **Registrar saída intervalo**, **Registrar retorno intervalo** e **Registrar saída**.
- O horário gravado é o **do servidor**, não o do seu computador ou celular.
- Para evitar duplicidade, duas marcações seguidas precisam de pelo menos **60 segundos** de intervalo.
- O quadro **Hoje** mostra as marcações do dia. O **Espelho da competência** mostra o mês.
- Variações pequenas, dentro da tolerância do art. 58, §1º, da CLT, aparecem indicadas e não geram ocorrência.

**Esqueceu de marcar?** Em Minha jornada → **Incluir marcação esquecida**: informe data, horário, tipo e justificativa → **Solicitar inclusão**. A gestão decide.

**Marcou errado?** **Desconsiderar marcação indevida**: escolha a marcação, justifique → **Solicitar desconsideração**. A marcação original **nunca é apagada**; a decisão fica registrada.

**Vai precisar fazer hora extra?** **Autorização prévia de hora extra**: data (hoje ou futura), minutos e destino pretendido (banco de horas ou pagamento) → **Solicitar autorização**.

Observações:
- Não é possível pedir correção de data futura, nem de dia anterior ao **início do controle no sistema**.
- Com a restrição de rede ativa, a marcação só é aceita na rede do cartório.

### 4.2 Banco de horas
Menu **Banco de horas**:
- **Saldo**, **Créditos por vencimento** e **Extrato de lançamentos**. Os créditos têm prazo para compensação, conforme o acordo. O sistema avisa com 30 dias de antecedência.
- **Ocorrências:** dias com diferença (hora extra, diferença negativa, falta). Em cada uma, use **Justificar** → escreva a justificativa → **Enviar justificativa**. A gestão decide.
- **Diferenças negativas não são descontadas automaticamente.** Elas aguardam decisão da gestão: abono, compensação com o banco ou falta não justificada.
- **Solicitar compensação:** para hoje ou datas futuras. As modalidades são folga integral, compensação parcial, entrada posterior e saída antecipada.
  - Precisa haver **saldo suficiente** e **acordo de banco de horas vigente**. Se não houver, o sistema recusa e explica o motivo.
  - Para dias passados, justifique na ocorrência em vez de pedir compensação.
  - **Folga integral começa na segunda ou na sexta-feira** e é comunicada com **48 horas** de antecedência (CCT, cl. 17, §2º — quando validada). Para folga de mais de um dia, peça primeiro o dia de início (ex.: segunda) e depois os seguintes. Entrada posterior e saída antecipada não têm essa restrição.
  - Pela CCT, **1 hora extra vira 1h30 de folga**, e o prazo para compensar é de **90 dias após o mês** em que a hora foi feita; o que não for compensado é pago como extra.

### 4.3 Meus documentos (espelho e extrato mensais)
Após o fim de cada mês:
1. Menu **Meus documentos** → **Gerar documento mensal**.
2. Escolha o **mês** e o tipo (**espelho de ponto** ou **extrato do banco de horas**) → **Gerar**. Só é possível depois que o mês termina.
3. Confira o documento e registre a sua **manifestação**:
   - **Ciência:** apenas tomou conhecimento. Não significa concordar.
   - **Concordância:** concorda com o conteúdo.
   - **Contestação:** discorda. Escreva os motivos.
4. A manifestação pede o código do autenticador e fica ligada **exatamente àquela versão** do documento. Se uma versão nova for gerada, assine a mais recente.
5. Depois, a gestão confere e aprova. Se houve contestação, a gestão precisa registrar a análise por escrito.

O espelho traz a ressalva de que o SGI é um **controle administrativo**, e não um registrador eletrônico de ponto (REP).

### 4.4 Solicitações
Menu **Solicitações** → aba **Minhas**: acompanhe tudo o que você pediu (correção de ponto, compensação, autorização de hora extra) e a decisão de cada pedido. Enquanto estiver pendente, você pode **cancelar** a solicitação.

### 4.5 Férias
Menu **Férias**:
- **Períodos aquisitivos:** direito, dias usados e saldo de cada período.
- **Solicitar férias:** informe **Início**, **Fim**, **Abono pecuniário (dias)**, se houver, e uma **Observação** → **Enviar solicitação**.
- **Regras que o sistema confere ou avisa:**
  - comunicação com **30 dias de antecedência** (art. 135 da CLT);
  - as férias **não podem começar nos dois dias que antecedem feriado ou domingo**;
  - o **saldo restante não pode ficar abaixo de 5 dias**;
  - as férias de um período aquisitivo **só começam depois que ele termina**;
  - não pode haver outra ausência lançada no mesmo período.
- **Programação de férias:** fica no **fim da página** e mostra o planejamento.
- Férias já iniciadas não podem ser canceladas pelo sistema. Fale com a gestão.

### 4.6 Plantões RCPN
Menu **Plantões RCPN**: veja a **escala da competência**. Quem está de plantão registra os **chamados** (horário de chegada e de saída do comparecimento) dentro do horário do plantão. O fechamento é feito pela gestão (ver 5.7).

### 4.7 Gestão documental (documentos da serventia)
Menu **Gestão documental**:
- **Repositório:** documentos vigentes destinados a você. Pesquise pelo título ou por palavras do texto.
- **Para ciência:** documentos que exigem a sua ciência. Abra, leia, marque a declaração e clique em **Registrar ciência** (pede o código do autenticador). Cada **nova versão** pede nova ciência.
- Documentos confidenciais só aparecem para as pessoas indicadas nominalmente.

### 4.8 Tarefas
Menu **Tarefas** → **Minhas tarefas**: suas atividades organizadas por urgência (**Imediatas e urgentes**, **Vencidas**, **Hoje**, **Próximas e sem prazo**), inclusive as **rotinas do dia**, que aparecem sozinhas.

Na tarefa:
- **Iniciar** e **Concluir**. Se houver checklist, conclua todos os itens.
- **Registrar impedimento:** descreva o que impede.
- **Encaminhar para decisão:** descreva a questão. As ordinárias vão para a Substituta e as complexas para a Oficial.
- **Comentários internos** e **Anexos**.
- Tarefas com aprovação seguem, ao concluir, para quem aprova.

Outras visões: **Lista**, **Quadro** (kanban), **Calendário** e **Painel**. Para criar uma tarefa, use **Nova tarefa**.

### 4.9 Agenda
Menu **Agenda**: próximos eventos institucionais (reuniões, prazos e treinamentos), férias, plantões e marcos de projetos.

### 4.10 Treinamentos
Menu **Treinamentos** → **Meus treinamentos**: os obrigatórios e a validade de cada um.
- **Estudo de POP:** registre a ciência da versão vigente em Gestão documental, faça a avaliação (se houver) e clique em **Concluir estudo**.
- **Curso externo:** **Enviar certificado de curso concluído**. Outra pessoa valida.

### 4.11 Avaliações e PDI
Menu **Avaliações e PDI** → **Minhas avaliações**:
- Faça a **autoavaliação**, quando prevista.
- Depois que a avaliação for enviada, registre a **manifestação**: **ciência** (não significa concordar), **concordância** ou **discordância** com motivos. O prazo é de 10 dias.
- Acompanhe o seu **PDI** (plano de desenvolvimento) e os **feedbacks**.

### 4.12 Comunicar incidente
Menu **Comunicar incidente**. Para quem tem acesso à Qualidade, fica em **Qualidade e segurança → Incidentes**.

Use quando houver:
- perda ou roubo de equipamento ou celular;
- acesso indevido;
- e-mail suspeito aberto;
- vazamento de informação;
- sistema fora do ar.

Descreva o fato **sem incluir dados pessoais além do necessário** e marque se pode envolver dados pessoais. Você acompanha o que comunicou na mesma tela.

### 4.13 Privacidade
Você vê **somente os seus próprios dados**. Dúvidas sobre dados pessoais devem ir ao **encarregado(a) de dados** da serventia (LGPD), conforme definido pela Oficial.

---

## 5. Para a gestão (Coordenação, Substituta Legal e Oficial)

### 5.1 Equipe — admissão
Menu **Equipe** → **Admitir funcionário**:

| Campo | Observação |
|---|---|
| Matrícula, Nome completo, Nome social (opcional) | |
| Cargo, Função, Setor | o cargo e o setor vêm de listas (ver 9.1) |
| **Data de admissão** | a data **real** |
| **Início do controle no sistema** | a data a partir da qual o SGI apura a jornada. **Obrigatório** quando a admissão tem mais de 31 dias. Para quem já trabalhava antes do sistema, use a data da implantação. Sem ela, todos os dias desde a admissão apareceriam como faltas |
| Tipo de contrato, Horas semanais | |
| Jornada contratual | escolha uma jornada cadastrada, ou **Definir depois** |
| E-mail institucional | cria o **acesso** da pessoa, com o papel Colaborador. Use o **e-mail principal** exatamente como aparece em admin.google.com → Usuários (apelidos não funcionam) |

Clique em **Admitir**. Para dar poderes de gestão, atribua o papel em **Usuários e permissões** (ver 9.2).

### 5.2 Ficha do funcionário
Em **Equipe**, clique no nome da pessoa. Quadros da ficha:
- **Dados funcionais** e **Histórico de cargos e setores**.
- **Jornada contratual:** troca com data de vigência.
- **Acordo de banco de horas:** cadastre-o com a referência do instrumento assinado. **Sem acordo vigente, horas extras não vão para o banco**, apenas para pagamento.
- **Dados pessoais sensíveis** e **Histórico salarial:** só a Oficial; pedem reautenticação.
- **Início do controle no sistema:** pode ser alterado com motivo, desde que não haja marcações, ocorrências analisadas ou lançamentos antes da nova data, nem competência fechada no meio.
- **Férias, afastamentos e ausências.**
- **Checklists:** admissão e desligamento. Inclui os **Itens entregues** (uniforme, equipamento), com o **termo** de entrega: versão, ato e data da assinatura, com link para o documento.
- **Desligamento:** registra a saída e **revoga os acessos na hora**.

### 5.3 Ocorrências (decisão diária)
Menu **Ocorrências** → **Pendentes** / **Resolvidas**. Só a Substituta e a Oficial decidem.

| Tipo de ocorrência | Decisões possíveis |
|---|---|
| **Hora extra** | **Crédito no banco** (exige acordo vigente) ou **Pagamento como extra** |
| **Diferença negativa** (atraso, saída antecipada) | **Abono**, **Compensar com banco** ou **Falta não justificada (análise da folha)** |
| Alertas, como intervalo menor que 1 h em jornada acima de 6 h (art. 71 da CLT) | **Ciente** |

- **Abono** e **Falta não justificada** exigem **fundamentação**.
- **Sábado, domingo e feriado** (CCT 2026/2027, cl. 17, §§5º e 6º — quando a regra estiver validada): a hora extra **não vai para o banco**; decida **Pagamento como extra**. Exceções — escolha no campo que aparece abaixo da decisão: **atendimento de casamento** ou **curso/palestra** (só em sábado, até 4 sábados por ano). Plantões do RCPN seguem pelo fechamento do plantão.
- Veja a justificativa enviada pelo funcionário antes de decidir.
- A decisão é registrada e o funcionário é avisado.

### 5.4 Solicitações → Para decidir
Menu **Solicitações** → **Para decidir**: correções de ponto, compensações e autorizações de hora extra. Aprove ou rejeite (a rejeição exige motivo). O histórico fica em **Decididas**.

### 5.5 Espelhos → Aguardando aprovação
Menu **Meus documentos** → **Aguardando aprovação**: documentos mensais da equipe.
- **Dupla conferência:** a aprovação só é possível **depois da manifestação do funcionário**.
- Se houve **contestação**, registre a análise no comentário.

### 5.6 Férias (gestão)
Abra **Férias** pela ficha do funcionário, ou pelo menu.

**Antes de aprovar**, faça a **Conferência das faltas do período aquisitivo** (art. 130 da CLT):
- Faltas integrais sem decisão bloqueiam a conferência. Decida-as antes em Ocorrências.
- A conferência registra a faixa do art. 130 e a memória de cálculo, e pede reautenticação.
- Se houver novas decisões depois, ela fica **desatualizada** e precisa ser refeita.
- Em período iniciado **antes da implantação**, informe em **Faltas injustificadas anteriores à implantação** as faltas do controle anterior, com a origem na observação.

Outros pontos:
- **Férias anteriores à implantação:** um lançamento por período aquisitivo, com início do gozo, dias gozados, abono e **origem da informação** (aviso ou recibo). Assim os períodos já quitados não aparecem como vencidos. Vale só para férias iniciadas antes do início do controle.
- **Alertas de vencimento:** saldos perto do fim do período concessivo ou já vencidos.
- **Perda do direito (art. 133):** tratamento manual, com fundamentação.
- **Programação de férias:** no fim da página.

### 5.7 Plantões RCPN (gestão)
Menu **Plantões RCPN**:
- **Gerar escala em rodízio**, para o mês, ou **Plantão avulso**, para datas futuras.
- **Alterar** ou **Cancelar plantão**: só plantões planejados. Plantão com chamado registrado é **fechado**, não cancelado.
- Se um substituto atendeu, **troque o responsável antes de fechar**.
- **Fechar plantão:** se houve trabalho efetivo, informe o destino: **banco de horas** (exige acordo) ou **pagamento**.
- O sobreaviso e o trabalho efetivo são apurados **separadamente**.
- **Relatório da competência:** traz os plantões fechados.

### 5.8 Relatórios (folha)
Menu **Relatórios** → **Relatório para a folha de pagamento** → **Exportar CSV**, para a contabilidade. Traz extras pagas, faltas não justificadas, créditos e débitos do banco.

### 5.9 Fechamento do mês (competência)
**Configurações → Competências** → **Fechar ou reabrir**:
- O fechamento exige **zero pendências**: ocorrências, solicitações e espelhos.
- Uma competência fechada **bloqueia** correções e decisões retroativas.
- A reabertura exige **motivo**.

### 5.10 Tarefas, projetos, rotinas e processos (gestão)
- **Nova tarefa:**
  - escolha responsável, setor, prazo e prioridade;
  - adicione checklist, dependências e subtarefas, se precisar;
  - se a tarefa precisar de aprovação, **indique quem aprova a conclusão**. Essa pessoa precisa ser **diferente do responsável**.
- **Decidir encaminhamento:** registre a orientação ou decisão na própria tarefa.
- **Projetos:** fases, marcos, custos realizados, equipe, indicadores e cronograma (Gantt). As abas são **Visão geral**, **Tarefas**, **Quadro**, **Cronograma (Gantt)** e **Equipe e dados**. Projeto encerrado não recebe tarefas.
- **Rotinas e processos:**
  - **Rotinas recorrentes:** atividades fixas que viram tarefas sozinhas a cada dia. Exemplo: centrais eletrônicas 4 vezes por dia (09:00, 11:00, 14:00 e 16:00).
  - **Modelos de processo:** uma etapa por linha, no formato `título | prazo | papel | aprovação s/n | documentos`.
  - **Processos em andamento** → **Iniciar processo:** as etapas viram tarefas em sequência.

### 5.11 Gestão documental (elaboração e aprovação)
Abas: **Repositório**, **Para ciência**, **Aprovações**, **Revisões**, **Categorias** e **Novo documento**.

1. **Novo documento** (aba): preencha os dados (Título, Código opcional, Categoria, Resumo, Setor responsável, Responsável, **Público destinatário** — setores ou pessoas —, **Confidencialidade** — restrito exige setores/pessoas; confidencial exige **pessoas nominalmente** — e **Revisão periódica (meses)**) → **Criar rascunho**. Nesta aba ainda **não** há campo de arquivo.
2. O sistema abre a página do documento. No quadro **Rascunho**: **Texto do documento** e/ou **Arquivo** (até 15 MB: PDF, DOCX, XLSX, ODT, ODS, PNG, JPG, TXT; passa pelo antivírus) e **Nota da versão** → **Salvar rascunho**. Um documento por arquivo; para vários arquivos, repita o processo.
3. Ainda na página do documento → **Submeter à aprovação** (o conteúdo é congelado como versão).
4. **Outra pessoa** aprova em **Gestão documental → Aprovações** → **Aprovar e tornar vigente** (ou **Rejeitar**, com o que precisa ser ajustado). **Quem elaborou/submeteu não aprova** a própria versão — nem a Oficial (decisão de 29/10/2026).
5. Os destinatários registram a **ciência**. O quadro **Ciência da versão N** mostra a cobertura.
6. **Nova revisão:** **Editar** → **Salvar rascunho**, com a **nota da versão** (o que mudou) → Submeter.
7. **Declarar obsoleto** (só documento vigente) e **Arquivar**.
8. **Descarte do conteúdo:** só para documentos obsoletos ou arquivados, com **prazo de retenção definido e fundamentado** na categoria. Os metadados e o hash são preservados.
9. **Revisões:** mostra as revisões vencidas ou próximas. O responsável é avisado.
10. **Exportar:** JSON com hashes.

---

## 6. Financeiro gerencial

> Módulo **gerencial**: **não substitui** a escrituração nem o Livro Diário Auxiliar.

Menu **Financeiro**. Abas: **Painel**, **Contas a pagar**, **Solicitar despesa**, **Contratos**, **Fornecedores**, **Orçamento**, **Receitas**, **Relatórios** e **Centros e categorias**. Cada aba aparece conforme a permissão.

### 6.1 Antes de usar (cadastros)
Em **Centros e categorias** e em **Fornecedores**:
- cadastre os centros de custo e os fornecedores (CNPJ ou CPF válido);
- ajuste as categorias;
- registre o orçamento anual em **Orçamento**.

### 6.2 Fluxo de uma despesa
1. **Solicitar despesa:** tipo **Fixa**, **Variável** ou **Compra**, com descrição, valor, vencimento, categoria, centro de custo e fornecedor.
   - **Compra** exige **justificativa** e **cotações**. O quadro **Cotações** só aparece em despesas do tipo Compra.
   - Indique a cotação escolhida. Se não for a de menor valor, **justifique**.
2. **Aprovação:** em **Painel → Para sua aprovação**, registre a **Decisão** (aprovar ou rejeitar).
3. **Pagamento:** em **Contas a pagar** / **Para pagamento**, abra a despesa:
   1. anexe o **comprovante** (o anexo só é aceito depois da aprovação);
   2. clique em **Registrar pagamento**: data (não futura), valor e forma (PIX, boleto, transferência, débito automático, cartão ou dinheiro).
   - O **valor pago deve ser igual ao aprovado**. Pagamento parcial não é admitido: o ajuste exige nova solicitação.
   - O registro do pagamento é **definitivo**. Despesa paga não é cancelada; ajustes são feitos por nova solicitação ou estorno.
4. **Anexos:** notas fiscais, comprovantes, contratos e orçamentos.

### 6.3 Regra das três pessoas e a exceção da Oficial
- Em regra, **quem solicita não aprova**, e **quem solicita ou aprova não paga**.
- **Exceção, por decisão da serventia:** a **Oficial** pode solicitar, aprovar e pagar a mesma despesa. A auditoria registra "segregação dispensada por parâmetro". Só a Oficial pode desligar esse parâmetro.
- **Limite de aprovação delegada** (Configurações → Parâmetros): acima do valor definido, só a Oficial aprova. Vem desativado por padrão.
- O painel **avisa** quando uma despesa aprovada não tem quem a pague.

### 6.4 Contratos e despesas fixas mensais
- **Contratos:** **Novo contrato**, com valor mensal e dia de vencimento (os dois juntos) e opção **Encerrar**.
- **Despesas fixas mensais** (sem contrato: assinaturas, tributos, folha, benefícios):
  - cada item tem valor, dia de vencimento, categoria, centro de custo e tipo do Asgard;
  - pode ser **alterado**, **desativado** (se já gerou lançamentos) ou **excluído**.
- **Importar de planilha:** envie o livro de um mês já fechado no formato do Asgard.
  - Cada linha vira uma despesa fixa: o dia vem da data, e também o valor e o tipo.
  - A categoria é sugerida, e linhas repetidas são ignoradas.
  - Depois, **revise** a lista e exclua o que não se repete todo mês.
- **Lançar despesas fixas do mês:** uma vez por mês. Gera as despesas dos contratos e das fixas, sem duplicar, e elas seguem para aprovação.
  - Valores que variam (energia, encargos) são **estimativas**: ajuste a solicitação antes de aprovar.
  - Itens sem valor não são lançados.
- **Salários:** os lançamentos de folha ficam visíveis a quem vê o centro de custo. Para restringir, use um centro de custo próprio (ex.: *PES — Pessoal*).

### 6.5 Receitas, orçamento e relatórios
- **Receitas:** **Lançar receita**, um lançamento gerencial para o fluxo de caixa. Correções são feitas por **Estornar**, com motivo; um estorno não pode ser estornado.
- **Orçamento:** previsto × realizado por ano.
- **Relatórios → Resumo:**
  - despesas por categoria, por centro de custo e por setor (6 meses);
  - fluxo de caixa gerencial, projeção de saídas e custo de pessoal;
  - **Exportar CSV**.

### 6.6 Planilha para o Asgard
**Relatórios → Gerar relatório XLS Asgard**:
1. **Modelo do Asgard:** envie **uma vez** o modelo exportado do Asgard. A lista de tipos é lida da aba de configuração. Reenvie se os tipos mudarem.
2. **Correspondência padrão:** defina o tipo do Asgard por **categoria** e por **fornecedor**. O do fornecedor prevalece.
3. Escolha o **mês de referência**. O padrão é o mês anterior. Entram **todas as despesas pagas no mês**, uma linha por pagamento, com a data do pagamento.
4. Ajuste, se preciso, o **tipo** de uma despesa, o **nº do documento fiscal** e o **nº da autorização prévia**. Linhas sem tipo ficam destacadas.
5. Com todas as linhas com tipo, clique em **Gerar relatório XLS Asgard** e importe o arquivo no Asgard.
   - A descrição sai como "descrição - fornecedor".
   - A geração fica registrada na auditoria.

---

## 7. Qualidade e segurança da informação

Menu **Qualidade e segurança**. Abas: **Painel**, **Requisitos**, **Auditorias**, **Não conformidades**, **Riscos**, **Ativos**, **Backups** e **Vulnerabilidades**. Os incidentes ficam em **Incidentes**.

1. **Requisitos:** cadastre cada requisito a partir da **fonte oficial** (norma ou item), com responsável e periodicidade de revisão. Nada vem pré-carregado. Registre **evidências** e **avalie**. Alguns itens exigem a indicação da evidência: documento, protocolo ou local de arquivamento.
2. **Auditorias internas:**
   - **Planejar auditoria interna**, com auditor líder de fora do setor auditado;
   - importe os requisitos ou escreva as perguntas;
   - inicie, avalie cada item com evidência e **Concluir auditoria**.

   A auditoria concluída fica **imutável** e atualiza os requisitos. Itens não conformes abrem uma **não conformidade** automaticamente.
3. **Não conformidades:**
   - **Análise de causa raiz** e **Ações**, que viram tarefas;
   - ao concluir, a **verificação de eficácia** é feita por **outra pessoa**;
   - o registro indevido pode ser cancelado, com motivo.
4. **Riscos:**
   - probabilidade e impacto de 1 a 5, controles e risco residual;
   - **Reavaliar** na periodicidade;
   - **aceitar risco alto ou crítico é decisão da Oficial**.
5. **Incidentes:**
   - **Tratamento:** contenção e causa raiz;
   - **Avaliação LGPD**, quando há dados pessoais;
   - **Linha do tempo** e **Encerrar**.
6. **Ativos:** inventário com validade, como **certificados digitais** e licenças. O sistema avisa 60 dias antes do vencimento.
7. **Backups:** registre backups e **testes de restauração**. O teste é recomendado a cada 90 dias.
8. **Vulnerabilidades:** prazos de correção de 7 dias (crítica), 30 (alta), 90 (média) e 180 (baixa).

---

## 8. Treinamentos e avaliações de desempenho

### 8.1 Treinamentos (gestão)
Abas: **Meus treinamentos**, **Capacitação da equipe**, **Catálogo** e **Validações**.
- **Catálogo → Novo treinamento:**
  - tipo: curso interno ou externo, estudo de POP, palestra, sistema, integração de novos ou outro;
  - público obrigatório e reciclagem;
  - **avaliação de aprendizagem**, com questões no formato `Pergunta | a | *correta | c` (o asterisco marca a correta).
- **Turmas:**
  - **Nova turma** (aparece na agenda) → **Gerir turma** → encerrar com a **lista de presença**;
  - para curso já realizado, use **Registrar conclusão**.
- **Validações:** valide os certificados externos enviados.
- **Matriz de capacitação obrigatória**, em Capacitação da equipe: quem está em dia, a vencer ou vencido.

### 8.2 Avaliações (gestão)
Abas: **Minhas avaliações**, **Para avaliar**, **Equipe**, **Modelos** e **Programação**.
- **Modelos:** critérios no formato `GRUPO | Critério | peso` → publicar.
- **Programação:** por exemplo, 30, 60 e 90 dias após a admissão (experiência) e anual. Defina os prazos conforme o contrato. **O sistema não altera contratos nem aplica efeitos.**
- **Para avaliar:** preencher → enviar. O avaliado se manifesta. Também há:
  - **Retificar**;
  - **Encerrar sem ciência**, depois do prazo;
  - **Feedback documentado**;
  - **PDI**;
  - **Histórico por pessoa**.

---

## 9. Administração

### 9.1 Configurações
Abas:
- **Setores e cargos:** estrutura. Já existem os setores Diretoria e Administração, Atendimento, RI, RCPN e RTD/PJ, e os cargos Oficial Registradora, Substituta Legal, Escrevente Substituta, Escrevente Autorizado, Atendente e Auxiliar de Serviços Gerais.
- **Jornadas:** a padrão é "Padrão 40h — 08h às 17h" (seg–sex, 08–12 e 13–17). Use **Nova jornada** para horários diferentes.
- **Feriados:** os nacionais de 2026–2027 já constam. **Inclua os estaduais e os municipais** de Capivari de Baixo.
- **Parâmetros:** inatividade, reautenticação, alertas, divisor e adicional de horas, antecedência de férias, limites financeiros, prazos de segurança e outros.
- **Competências:** fechar ou reabrir o mês (ver 5.9).
- **Regras jurídicas:**
  - cadastre os instrumentos normativos (lei, CCT, súmula) e as regras parametrizadas, com fundamento e fonte;
  - a regra só passa a valer com **Registrar validação** (nome e cargo de quem conferiu, data e observação — ex.: a Oficial, como empregadora); as regras da CCT 2026/2027 já vêm cadastradas como pendentes: basta conferir e validar cada uma;
  - regras históricas nunca valem.
- **Modelos de checklist:** **Editar (nova versão)** → ajustar itens → **Publicar**. Checklists já abertos não mudam.
- **Integrações:** Google Agenda, Gmail e Chat. Tudo começa desligado; ative depois de configurar. A tela mostra os últimos erros e tem a opção **Reenviar mensagens com falha**.
- **Rede:** ver 9.5.

### 9.2 Usuários e permissões (Oficial)
- **Usuários:** lista. Clique numa pessoa para:
  - **Atribuir papel:** papel, setor coordenado (para Coordenação), **De**, **Até** (só para substituição temporária) e **Motivo / fundamento** → pede o código do autenticador;
  - **Revogar** um papel;
  - **Alterar situação:** Ativo, Suspenso ou Revogado. A suspensão **bloqueia na hora**;
  - **Redefinir autenticador:** troca de celular.
  - **Corrigir e-mail:** só enquanto a pessoa nunca entrou. Use o **e-mail principal** da conta no Google Workspace (admin.google.com → Diretório → Usuários, coluna E-mail), não um apelido.
- **Criar usuário:** para quem não é funcionário. Funcionários ganham acesso pela admissão.
- **Matriz de permissões:** o que cada papel pode fazer, e o escopo de cada permissão (próprio, setor ou todos).
- **Novo papel:** código, nome e descrição. Depois, marque as permissões na matriz.

### 9.3 Auditoria
Menu **Auditoria**: busca por pessoa, ação e período. **Mensalmente**, use **Verificar integridade da cadeia**. Qualquer alerta aciona o tratamento de incidente.

### 9.4 Automações
Regras de **aviso** e de **criação de tarefas**. Use **Executar agora** para testar e consulte os **Últimos disparos**.

### 9.5 Rede (restrição de acesso)
**Configurações → Rede:**
- A faixa do alto mostra se a restrição está **ATIVA** e o **seu endereço de internet agora**.
- **Endereços permitidos:** um por linha. Inclua o IP fixo do cartório e o da conexão reserva, se houver.
- ☑ **Restringir o uso do sistema a estes endereços**.
- ☑ **Marcação de ponto somente na rede da serventia**.
- **Plantão: acesso externo antes e depois (minutos).**
- **Liberações temporárias:** pessoa, **Até** (no máximo 31 dias) e **Motivo**.
- **Acessos recusados recentes:** mostra quem foi bloqueado e de qual endereço.

**Se a internet do cartório mudar de endereço:** quando 2 ou mais pessoas forem recusadas do mesmo endereço novo em 1 hora, a Oficial e quem administra as configurações recebem o aviso **"Acessos recusados a partir de um endereço novo"**. **Estando no cartório:**
1. abra **Configurações → Rede**;
2. acrescente o endereço atual numa **nova linha**;
3. clique em **Salvar**;
4. dias depois, remova o endereço antigo.

Marcações perdidas entram por pedido de correção.

### 9.6 Convenção coletiva e acordos individuais

**Guardar a íntegra da convenção (CCT):**
1. *Gestão documental → Categorias → Nova categoria* (uma vez): código `CCT`, nome **Convenções e acordos coletivos**, revisão 12 meses, confidencialidade padrão **Interno**, *Ativa* → **Criar categoria**.
2. *Novo documento*: título "Convenção Coletiva de Trabalho 2026/2027 — SC000957/2026", código `CCT-2026`, categoria **Convenções e acordos coletivos**, resumo com as partes, a vigência e o nº da solicitação, público **todos os setores**, **Interno** → **Criar rascunho**.
3. No quadro **Rascunho**: **Arquivo** = PDF da CCT (no Mediador: *Imprimir → Salvar como PDF*), nota "Registrada no MTE em 18/05/2026" → **Salvar rascunho** → **Submeter à aprovação**; outra pessoa aprova em *Aprovações*.
4. *Configurações → Regras jurídicas → Instrumentos normativos* → SC000957/2026 → **Alterar situação**: **Vigente — validado**, observação "Íntegra em Gestão documental, código CCT-2026".

**Regras da CCT valem para todos.** Ficam em *Configurações → Regras jurídicas* e não variam por pessoa. Um contrato ou acordo individual **não pode reduzir** o que a CCT garante (CLT, art. 619); pode apenas ser mais favorável. O conteúdo de uma regra não se edita: para mudar, **Encerrar vigência** (data e motivo) e **Cadastrar regra** nova (tipo, instrumento, início, valor, fundamento, fonte e validação).

**O que é individual (ficha do funcionário, em *Equipe*):**
- **Jornada contratual:** horários diferentes (meio período, 6 h, entrada às 9 h…) — crie em *Configurações → Jornadas → Nova jornada* e atribua na ficha (*Jornada contratual → Atribuir jornada*, com a data de início).
- **Acordo de banco de horas** (a CCT exige acordo individual escrito — cl. 17, §4º): *Cadastrar acordo* com modalidade **Individual escrito**, prazo em meses (com a regra da CCT validada vale o prazo da CCT, 90 dias após o mês), início e término, **limite diário de extras** (120 min numa jornada de 8 h respeita o teto de 10 h da CCT), **Instrumento assinado** (nº/arquivo do acordo) e, só se o acordo prever, **Admite saldo negativo**. Para mudar condições: **Encerrar** o acordo atual e cadastrar o novo.
- **Contrato e acordo assinados:** guarde em *Gestão documental*, categoria **Contratos de trabalho** (confidencial — indique as pessoas pelo nome).
- **Cargo, setor, horas semanais e salário:** na ficha, com data de vigência (salário só a Oficial).
- **Situações pontuais** (prova de estudante, dirigente sindical, atestado): decida em *Ocorrências* (**Abono**), citando a cláusula.

Se algum contrato individual previr condição **mais favorável** que a CCT em ponto que o sistema aplica para todos (ex.: conversão maior que 1h30), o sistema ainda não tem exceção por pessoa: registre a condição na observação do acordo e trate por ajuste manual até que essa opção seja incluída.

---

## 10. Rotinas recomendadas

**Todo dia (funcionários):** marcar o ponto, ver **Minhas tarefas** e o sino de notificações.

**Todo dia ou toda semana (Substituta ou Oficial):**
- **Ocorrências** pendentes;
- **Solicitações → Para decidir**;
- **Gestão documental → Aprovações**;
- **Financeiro → Para sua aprovação** e **Para pagamento**.

**Todo mês:**
1. **No início do mês:** **Financeiro → Contratos → Lançar despesas fixas do mês**. Ajuste as estimativas e aprove.
2. **Depois do fim do mês:** cada funcionário gera o espelho e o extrato e se manifesta (**Meus documentos**). A gestão aprova em **Aguardando aprovação**.
3. **Relatórios → Exportar CSV** para a folha.
4. **Configurações → Competências → fechar o mês**, com zero pendências.
5. **Financeiro → Relatórios → Gerar relatório XLS Asgard** do mês anterior → importar no Asgard.
6. **Auditoria → Verificar integridade da cadeia.**
7. **Banco de horas:** conferir créditos a vencer e registrar pagamentos em folha, se houver.

**Periodicamente:**
- revisões de documentos;
- reavaliação de riscos;
- testes de restauração de backup (90 dias);
- validade de certificados digitais e licenças;
- treinamentos a vencer;
- avaliações programadas.

**Todo ano:**
- feriados do ano seguinte (estaduais e municipais);
- orçamento do ano;
- revisão dos papéis e acessos;
- revisão das regras jurídicas (CCT nova).

---

## 11. Problemas comuns e soluções

| Situação | O que fazer |
|---|---|
| "Acesso permitido apenas na rede da serventia" | Você está fora da rede do cartório (ou no 4G). Ligue o Wi-Fi da serventia. Se estiver no cartório e várias pessoas forem bloqueadas, o IP mudou: avise a Oficial ou a Substituta (ver 9.5) |
| "Acesso não autorizado. Sua conta precisa estar previamente cadastrada e ativa" | A conta Google usada não bate com o cadastro. Veja em **Auditoria** o registro "Login negado" (mostra o e-mail tentado). Se a pessoa escolheu outra conta, entre por janela anônima e digite o e-mail institucional. Se o cadastro foi feito com um **apelido** (o Google sempre devolve o **e-mail principal**, que aparece em admin.google.com → Usuários), use **Usuários e permissões → a pessoa → Corrigir e-mail** (só antes do primeiro acesso) |
| Código do autenticador recusado | Use o código da conta **certa** (produção, não homologação). Espere o código seguinte, porque cada código vale uma vez. Confira se a hora do celular está automática |
| Troquei ou perdi o celular | Peça para **Redefinir autenticador** (ver 2.6). Se perdeu, comunique um incidente |
| Um item do menu não aparece | O seu papel não dá acesso. Peça à Oficial, se for necessário para a sua função |
| A tela voltou para o login | A sessão expirou (30 min sem uso, ou 12 h no total). Entre de novo |
| O sistema demora no primeiro acesso do dia | O sistema "acorda" sozinho às 07:45 nos dias úteis. Fora disso, o primeiro acesso pode levar alguns segundos |
| Anexo recusado | Pode ser: arquivo acima do limite (15 MB em documentos); **vírus detectado**; ou o antivírus ainda carregando, nos primeiros 2 a 3 minutos depois que o sistema "acorda". Tente de novo em alguns minutos |
| "O documento mensal só pode ser gerado após o término da competência" | O espelho do mês só sai depois que o mês acaba |
| Compensação recusada | Falta saldo, não há acordo de banco vigente, a data é passada (justifique na ocorrência), faltam 48 h de antecedência, ou a folga integral não começa na segunda/sexta |
| "Trabalho em sábado, domingo ou feriado não entra no banco" | Regra da CCT: decida **Pagamento como extra**, ou marque a exceção (casamento; curso/palestra em sábado) |
| Não consigo aprovar o meu próprio pedido, documento ou tarefa | É proposital: quem pede ou elabora não aprova |
| "Registrar pagamento" não aparece | A despesa ainda não foi aprovada, ou você foi quem solicitou ou aprovou (só a Oficial é exceção) |
| Não acho onde enviar o arquivo de um documento | Primeiro crie o documento na aba **Novo documento** (só dados) → **Criar rascunho**; o campo **Arquivo** aparece na página do documento, no quadro **Rascunho** |
| "Cotações" não aparece | Só aparece em despesas do tipo **Compra** |
| Não consigo aprovar o espelho | O funcionário ainda não se manifestou (dupla conferência) |
| Férias não aprovam | Falta a **Conferência das faltas** do período, ou ela ficou desatualizada |
| Correção recusada por data | Datas futuras e datas anteriores ao início do controle não aceitam correção. Competência fechada também bloqueia |
| O formulário deu erro | Leia a mensagem em vermelho. Os dados digitados **são mantidos**: corrija e envie de novo |
| Vejo a faixa "Ambiente de homologação" | Você está no endereço antigo, de testes. Use o endereço de produção, no topo deste manual |

---

## 12. Limites legais e cuidados

- O controle de jornada do SGI é **administrativo**. **Não é** um registrador eletrônico de ponto (REP), e o sistema **não declara conformidade com a Portaria MTP 671/2021**. A adequação ao regime de ponto da serventia é responsabilidade da Oficial, com orientação jurídica.
- Parâmetros trabalhistas, como tolerância, divisor, adicional, banco de horas e art. 130, **dependem de validação jurídica** e da convenção coletiva vigente.
- As manifestações e aprovações com código do autenticador são **assinaturas eletrônicas simples**. **Não substituem** a assinatura qualificada (ICP-Brasil) onde a lei a exige.
- O **financeiro é gerencial** e **não substitui** a escrituração nem o Livro Diário Auxiliar.
- **LGPD:**
  - cada pessoa vê só o necessário;
  - dados sensíveis e salários ficam restritos à Oficial;
  - mensagens externas (e-mail, Chat) não levam conteúdo sensível;
  - incidentes com dados pessoais são avaliados pelo encarregado(a).
- **Nunca** compartilhe códigos do autenticador nem deixe a sessão aberta em computador de uso comum.

---

## 13. Glossário

| Termo | Significado |
|---|---|
| **Abono** | Diferença negativa aceita sem desconto, com fundamentação |
| **Acordo de banco de horas** | Instrumento assinado que permite levar horas ao banco. É cadastrado na ficha |
| **Autenticador** | Aplicativo do celular que gera o código de 6 dígitos |
| **Ciência** | Registro de que a pessoa tomou conhecimento. Não significa concordância |
| **Competência** | O mês de apuração da jornada |
| **Conferência das faltas** | Verificação do art. 130 antes de aprovar férias |
| **Diferença negativa** | Tempo trabalhado abaixo da jornada (atraso, saída antecipada, falta parcial) |
| **Dupla conferência** | O espelho só é aprovado pela gestão depois da manifestação do funcionário |
| **Espelho** | Documento mensal com as marcações e a apuração do mês |
| **Início do controle no sistema** | Data a partir da qual o SGI apura a jornada de quem já trabalhava antes da implantação |
| **Ocorrência** | Dia com hora extra, diferença negativa, falta ou alerta, que aguarda decisão |
| **PDI** | Plano de desenvolvimento individual |
| **POP** | Procedimento operacional padrão |
| **Reautenticação** | Novo código do autenticador pedido em operações críticas (vale 10 min) |
| **Segregação** | Regra de que pessoas diferentes solicitam, aprovam e pagam (com a exceção da Oficial) |
| **Sobreaviso** | Tempo de plantão à disposição, sem trabalho efetivo |
| **Vigente** | Versão aprovada e em vigor de um documento |
