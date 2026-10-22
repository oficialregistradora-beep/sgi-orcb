# Guia de configuração — Google Drive e antivírus

Status: **código implementado e testado** (antivírus com ClamAV real; Drive com simulação da API do Google). **A ligação com a conta Google real da serventia ainda não foi feita**: ela exige acesso ao Google Workspace e ao Google Cloud da serventia, que só a Oficial (ou a equipe técnica autorizada) possui. Nenhuma senha, chave ou credencial deve ser enviada por chat ou e-mail; elas vão direto para o Secret Manager.

Depois de configurar, confira em **Configurações → Integrações**: cada item deve aparecer como **Ativa**.

---

## Parte A — Antivírus (obrigatório antes da produção)

Em produção, **sem antivírus configurado o sistema recusa o envio de arquivos** (falha fechada). O antivírus usado é o **ClamAV** (código aberto, sem licença paga), que atualiza as assinaturas de vírus sozinho várias vezes ao dia.

### A1. Instalação em servidor próprio ou homologação (Docker)
O `docker-compose.yml` já inclui o serviço `clamav`. Basta `docker compose up -d`. Na primeira subida, o ClamAV leva alguns minutos baixando as assinaturas; a aplicação espera.

### A2. Instalação no Google Cloud Run (arquitetura recomendada)
1. No serviço do Cloud Run, adicionar um **segundo contêiner (sidecar)** com a imagem `clamav/clamav:1.4`, porta 3310.
2. Na aplicação, definir `CLAMAV_HOST=127.0.0.1` e `CLAMAV_PORT=3310`.
3. Memória: o ClamAV com a base completa usa em torno de **1,5 a 3 GB de RAM**. Isso **aumenta o custo** do Cloud Run (estimar na calculadora do Google antes de contratar — decisão da Oficial). Alternativa de menor custo: uma VM pequena dedicada ao ClamAV na mesma rede privada.

### A3. Como o sistema usa o antivírus
- Todo anexo é verificado **antes de ser gravado**. Arquivo infectado é recusado, nada é gravado e o bloqueio fica na auditoria.
- Na **aprovação** de uma versão, o arquivo é verificado de novo (com as assinaturas mais recentes).
- Arquivo enviado antes da ativação do antivírus ("não verificado") é verificado **antes do primeiro download**.
- A tela do documento mostra "Verificado pelo antivírus" ou "Não verificado".

---

## Parte B — Google Drive (opcional; padrão: arquivos no banco de dados)

Por padrão os arquivos ficam no banco de dados (ADR 0009) e funcionam sem nenhuma configuração. O Drive é útil se a serventia preferir o espaço do Workspace. Em ambos os casos, **o acesso aos arquivos é sempre pelo sistema**, que confere a permissão e o hash.

### B1. No Google Cloud (projeto da serventia — P-02)
1. **APIs e serviços → Biblioteca → "Google Drive API" → Ativar.**
2. **IAM → Contas de serviço → Criar**: nome `sgi-documentos`. **Não atribuir papéis** no projeto (ela só precisa ser membro do Drive compartilhado).
3. **Cloud Run (recomendado, sem chave):** em *Segurança* do serviço, escolha `sgi-documentos` como identidade. Deixe `GOOGLE_DRIVE_SA_KEY` vazio.
   **Outro servidor:** crie uma chave JSON da conta de serviço, converta com `base64 -w0 chave.json` e grave o resultado no Secret Manager como `GOOGLE_DRIVE_SA_KEY`. Apague o arquivo da chave do computador.

### B2. No Google Workspace (console de administração)
4. **Criar o Drive compartilhado** "SGI — Documentos (não compartilhar)".
5. A conta de serviço é tratada pelo Google como **membro externo** ao domínio. Nas configurações do Drive compartilhado, permitir membros fora da organização **somente neste Drive** (se a política do domínio bloquear, o administrador do Workspace precisa liberar para a unidade organizacional de quem criou o Drive). *Verificar na tela do Workspace no momento da configuração: os nomes dos menus mudam com frequência.*
6. **Adicionar como membro** o e-mail da conta de serviço (`sgi-documentos@<projeto>.iam.gserviceaccount.com`) com o papel **Gerente de conteúdo** (suficiente: o sistema envia, lê e manda para a lixeira; não precisa excluir definitivamente).
7. **Membros humanos:** manter apenas **uma** conta de contingência da Oficial como Administradora. Ninguém mais. Desativar o compartilhamento com não membros e a cópia, o download e a impressão por leitores. O acesso direto pelo Drive fica registrado no **registro de auditoria do Drive** do Workspace.
8. Copiar o **ID** do Drive compartilhado (o trecho final do endereço `drive.google.com/drive/folders/<ID>`).

### B3. Na aplicação
9. Variáveis (Secret Manager / ambiente):
   ```
   DOCUMENT_STORAGE=drive
   GOOGLE_DRIVE_SHARED_DRIVE_ID=<ID do passo 8>
   GOOGLE_DRIVE_FOLDER_ID=            (opcional: uma pasta dentro do Drive compartilhado)
   GOOGLE_DRIVE_SA_KEY=               (vazio no Cloud Run)
   ```
10. Reiniciar a aplicação e conferir **Configurações → Integrações → Armazenamento dos arquivos: Ativa — Conectado ao Drive compartilhado "…"**.

### B4. O que muda com o Drive
- **Novos** arquivos vão para o Drive; os já gravados no banco continuam no banco (cada arquivo registra onde está). Migração dos antigos: não implementada (Pendente; pode ser feita depois por rotina específica).
- **Backup:** os arquivos no Drive **não** entram no backup do banco. Usar a retenção do Google Vault ou exportação periódica do Drive compartilhado (definir com a Oficial — ver docs/12).
- **Descarte por retenção:** o arquivo vai para a lixeira do Drive compartilhado e o Google o exclui definitivamente após 30 dias; o registro e o hash permanecem no sistema.
- Se o Drive ficar indisponível, o envio e o download de arquivos falham com mensagem clara; o restante do sistema continua funcionando.

---

## O que foi testado e como
| Item | Teste | Resultado |
|---|---|---|
| Antivírus | ClamAV 1.5.4 real (clamd via TCP), com base de assinaturas **local de teste** (o servidor oficial de assinaturas estava inacessível no ambiente de desenvolvimento): arquivo limpo, arquivo EICAR (padrão de teste da indústria), EICAR embutido em arquivo de 300 KB (vários blocos), antivírus fora do ar, produção sem antivírus, verificação no download e na aprovação | Aprovado |
| Drive | Servidor que simula a API do Google (token da conta de serviço com assinatura RS256 conferida, envio multipart, leitura, lixeira, consulta ao Drive compartilhado): envio, aprovação, download, adulteração no Drive, indisponibilidade, MD5 divergente, chave não reconhecida, descarte | Aprovado |
| Drive real da serventia | — | **Pendente (depende dos passos B1–B3)** |
