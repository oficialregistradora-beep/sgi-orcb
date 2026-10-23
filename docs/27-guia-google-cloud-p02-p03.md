# Guia — P-02 (infraestrutura Google Cloud) e P-03 (login Google)

Passo a passo para a serventia criar, **na conta Google da própria serventia**, o que é necessário para o ambiente de **homologação** na nuvem. Nenhuma senha, chave ou segredo deve ser enviado por chat ou e-mail: a entrega das credenciais é feita pelo campo de segredos do ambiente (passo 9).

> Os nomes de menus do console do Google mudam com frequência; se algum item não aparecer exatamente com o nome abaixo, use a busca do console (barra superior). Referência oficial do login: [Google Auth Platform — primeiros passos](https://support.google.com/cloud/answer/15544987).

## Antes de começar
- Use a conta de **administrador do Google Workspace** da serventia. O projeto precisa ficar **dentro da organização** do Workspace: só assim o login pode ser restrito às contas da serventia (público *Interno*).
- Tenha à mão: CNPJ e dados de faturamento, um cartão para a conta de faturamento e o e-mail institucional da Oficial.
- Custos estimados (produção): `01-entrega-1-planejamento.md` §4 — cerca de R$ 90 a R$ 310/mês. A homologação usa a mesma estrutura em tamanho mínimo e pode ser desligada depois do aceite.

## Antes de tudo — IP fixo do cartório
Para restringir o uso à rede da serventia, peça ao provedor de internet um **IP fixo** (endereço que não muda). Muitos planos empresariais já incluem; se não, é um adicional mensal. Anote o endereço informado pelo provedor.

## P-02 — Aprovar a infraestrutura e o faturamento
1. **Registrar a aprovação.** A Oficial aprova a Alternativa A (Cloud Run + Cloud SQL, região São Paulo) — um e-mail ou mensagem formal basta. Isso responde ao P-02.
2. **Conta de faturamento.** Em [console.cloud.google.com](https://console.cloud.google.com) → menu ☰ → **Faturamento** → **Gerenciar contas de faturamento** → **Criar conta**. Tipo de conta: empresa; informe os dados da serventia e o meio de pagamento.
3. **Orçamento e alertas (recomendado).** Faturamento → **Orçamentos e alertas** → **Criar orçamento**: por exemplo R$ 150/mês, com alertas em 50%, 90% e 100% para o e-mail da Oficial. O alerta avisa; ele não bloqueia gastos.
4. **Projeto de homologação.** Seletor de projeto (topo da tela) → **Novo projeto**:
   - Nome sugerido: `sgi-orcb-homolog`.
   - **Organização:** o domínio da serventia.
   - Vincule a conta de faturamento criada no passo 2.
   - Anote o **ID do projeto**, que aparece abaixo do nome.
   - A produção ficará em outro projeto (`sgi-orcb-prod`), criado só depois do aceite.

## P-03 — Login com a conta Google institucional
5. **Tela de login (marca e público).** Com o projeto de homologação selecionado: ☰ → **APIs e serviços** → **Google Auth Platform** (ou pesquise “Google Auth Platform”) → **Começar**.
   - **Branding / Informações do app:** nome `SGI — Ofício de Registros (homologação)` e e-mail de suporte (institucional).
   - **Público / Audience:** **Interno**. Só contas da serventia poderão entrar. Se *Interno* não aparecer, o projeto ficou fora da organização: volte ao passo 4.
   - **Contato:** e-mail institucional.
6. **Cliente OAuth.** Google Auth Platform → **Clientes** → **Criar cliente**:
   - Tipo **Aplicativo da Web**, nome `SGI homologação`.
   - **URIs de redirecionamento autorizados:** deixe em branco por enquanto. Depois da primeira publicação eu informo o endereço exato, no formato `https://<endereço-do-serviço>/api/auth/google/callback`, para você acrescentar.
   - Ao concluir, o Google mostra o **ID do cliente** e a **chave secreta do cliente**. Guarde-os para o passo 9 e **não os envie pelo chat**.
7. **Verificação em duas etapas (recomendado).** Em [admin.google.com](https://admin.google.com) → Segurança → Autenticação → **Verificação em duas etapas** → permitir e, se a serventia quiser, exigir para todos. O SGI já pede o código do autenticador no próprio sistema; esta é uma camada a mais, na conta Google.

## Entrega das credenciais para a configuração
8. **Conta de serviço de implantação.** ☰ → **IAM e administrador** → **Contas de serviço** → **Criar conta de serviço** `sgi-implantacao`, com os papéis:
   - Administrador do Cloud Run;
   - Administrador do Cloud SQL;
   - Administrador do Secret Manager;
   - Administrador do Artifact Registry;
   - Editor do Cloud Build;
   - Usuário da conta de serviço;
   - Administrador do Cloud Scheduler;
   - Administrador do Service Usage.

   Depois: **Chaves** → **Adicionar chave** → **JSON** (o arquivo é baixado).
   - Se aparecer o bloqueio *“A criação de chaves de conta de serviço está desativada”* (política `iam.disableServiceAccountKeyCreation`, ativa por padrão em organizações recentes), há dois caminhos. O primeiro é abrir uma exceção só neste projeto: IAM e administrador → **Políticas da organização** → essa política → personalizar para o projeto. O segundo dispensa a chave: avise, e eu preparo um script para você executar no **Cloud Shell** (o terminal do próprio console).
9. **Segredos do ambiente desta sessão de desenvolvimento.** No menu do ambiente (barra de título da sessão) → **Editar** → segredos / variáveis de ambiente, adicione:

   | Nome | Conteúdo |
   |---|---|
   | `GCP_PROJECT_ID` | ID do projeto (passo 4) |
   | `GCP_DEPLOY_KEY_B64` | conteúdo do arquivo JSON do passo 8, em base64 (ou o JSON inteiro, se o campo aceitar) |
   | `GOOGLE_CLIENT_ID` | ID do cliente (passo 6) |
   | `GOOGLE_CLIENT_SECRET` | chave secreta do cliente (passo 6) |

   Uma **nova sessão** passa a enxergar esses valores. Pelo chat, informe apenas o domínio institucional e os e-mails de quem vai homologar (Oficial e Substituta). Esses dados não são segredos.

## O que acontece depois (feito pelo desenvolvimento)
1. Habilitar as APIs.
2. Criar o banco Cloud SQL (com backups e recuperação pontual) e os segredos do sistema: chaves de cifragem geradas no próprio Google, sem passar pelo chat.
3. Publicar no Cloud Run com o antivírus e configurar a rotina diária.
4. Executar as migrações e carregar os dados fictícios de homologação, com as contas reais de quem vai testar.
5. Informar a URI de redirecionamento, que você acrescenta no passo 6.
6. Rodar, contra a nuvem, a suíte de testes, a sondagem de segurança, a acessibilidade, a carga e o teste de restauração, e entregar o relatório.
7. Você executa o roteiro `25-roteiro-homologacao.md`.

Ao fim da configuração, **revogue a chave** do passo 8 (Contas de serviço → Chaves → excluir). Uma nova chave só precisa ser criada quando houver nova publicação.
