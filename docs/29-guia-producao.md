# Guia — publicação da PRODUÇÃO (após o aceite)

Pré-requisito: aceite da homologação e autorização expressa da Oficial (enviados em 29/10/2026, ver `28-registro-homologacao.md`).
A produção usa **outro projeto** no Google Cloud (`sgi-orcb-prod`), separado da homologação: dados reais nunca se misturam com os fictícios.

## Diferenças em relação à homologação

| Item | Homologação | Produção |
|---|---|---|
| Projeto / banco | `sgi-orcb-homolog` / `sgi-homolog` (db-f1-micro) | `sgi-orcb-prod` / `sgi-prod` (db-g1-small) |
| Dados iniciais | fictícios (seed) | **nenhum**: só a Oficial é cadastrada (job `sgi-implantacao`); seed é recusado |
| Login de teste | desligado | desligado (e proibido) |
| Conexão com o banco | rede privada | rede privada **e cifrada** (TLS; o banco recusa conexão sem cifra) |
| Backups | 7 retidos | **30 retidos** + recuperação pontual de 7 dias + proteção contra exclusão |
| Aquecimento | — | 07:45 em dias úteis (sistema e antivírus prontos quando a equipe chega) |
| Confirmação | — | o script pede que se digite **PUBLICAR** |

## Passo a passo (serventia)

1. **Projeto:** console → seletor de projeto → *Novo projeto* → nome `sgi-orcb-prod`, organização `registroscapivari.com`.
2. **Faturamento:** *Faturamento* → vincular o projeto à conta de faturamento.
   ⚠️ A conta está em **avaliação gratuita** (créditos por 90 dias). Antes de os créditos acabarem ou o prazo vencer, clique em **Fazer upgrade / Ativar conta completa**; sem isso, a produção é **desligada** pelo Google ao fim da avaliação. Ajuste também o orçamento com alertas (ex.: R$ 400/mês).
3. **Login Google:** com `sgi-orcb-prod` selecionado, *Google Auth Platform* → *Começar* → nome `SGI — Ofício de Registros`, público **Interno** → *Clientes* → *Criar cliente* → *Aplicativo da Web*, nome `SGI`. Guarde o ID e a chave secreta (não enviar por chat).
4. **Publicar:** Cloud Shell (com `sgi-orcb-prod` selecionado) → upload do pacote do código →
   `rm -rf ~/sgi-orcb && unzip -q ~/sgi-orcb-vNN.zip -d ~ && cd ~/sgi-orcb && bash deploy/gcp-producao.sh`
   Responder: `PUBLICAR`, e-mail e nome da Oficial, ID do cliente e (sem aparecer na tela) a chave secreta.
5. **Endereço de retorno:** acrescentar no cliente `SGI` a URI mostrada ao final (`…/api/auth/google/callback`).
6. **Primeiro acesso:** a Oficial entra, cadastra o autenticador e segue a implantação (`14-plano-implantacao.md`, etapa 5): rede da serventia, equipe (com *início do controle*), férias anteriores, papéis, despesas fixas (importação da planilha do último mês fechado), modelo do Asgard.

## Registro

- 29/10/2026: produção publicada (`sgi-orcb-prod`, pacote v11) em https://sgi-orcb-416495482761.southamerica-east1.run.app — conta de faturamento convertida para conta completa, orçamento com alerta de R$ 400/mês (sem limite de gastos), cliente OAuth `SGI`, primeiro acesso da Oficial com autenticador concluído.

Atualizações futuras da produção: o mesmo comando do passo 4 (o banco e os cadastros são preservados; migrações novas são aplicadas).
