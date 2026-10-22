# ADR 0010 — Antivírus dos anexos e armazenamento opcional no Google Drive

**Situação:** aceita (Fase 3b, 22/10/2026). Complementa a ADR 0009.

## Antivírus
- **ClamAV (clamd)**, protocolo INSTREAM por TCP, sem dependências novas na aplicação. Código aberto e sem licença paga; o custo é a memória do processo (≈1,5–3 GB).
- **Falha fechada:** antivírus configurado e inacessível → envio recusado; produção sem antivírus → envio recusado. Fora de produção, sem antivírus, o anexo é aceito e marcado `NAO_VERIFICADO`.
- Verificação no **envio**, nova verificação na **aprovação** (assinaturas atualizadas) e no **primeiro download** de arquivo não verificado. Arquivo infectado nunca é gravado; o bloqueio é auditado (`DOC_ARQUIVO_INFECTADO`).
- O resultado (`scan_status`, mecanismo e data) fica em `document_files`; o banco só permite alterar esses campos e o descarte.

## Google Drive
- Ativado por `DOCUMENT_STORAGE=drive`. **Drive compartilhado** com a conta de serviço como *Gerente de conteúdo* e, no máximo, uma conta humana de contingência.
- Autenticação **sem chave no Cloud Run** (identidade do serviço via servidor de metadados) ou com chave JSON no Secret Manager em outros ambientes. Escopo `drive` (a conta de serviço só enxerga o Drive compartilhado do qual é membro).
- A aplicação continua sendo a **única via de acesso** para os usuários: os arquivos nunca são compartilhados por link; download sempre pela rota autorizada, com conferência do SHA-256 (detecta alteração feita diretamente no Drive).
- No envio, o tamanho e o MD5 devolvidos pelo Google são comparados ao arquivo enviado; divergência cancela o envio e manda o arquivo à lixeira.
- Descarte por retenção: lixeira do Drive compartilhado (exclusão definitiva pelo Google após 30 dias), sem exigir papel de Administrador para a conta de serviço.
- Cada arquivo registra o próprio armazenamento (`BANCO` ou `DRIVE`), o que permite trocar a configuração sem migrar o acervo existente.
- Em produção, os endereços da API do Google não podem ser substituídos por configuração (evita desvio para servidor falso).

## Consequências
- Com o Drive, os arquivos saem do backup do banco: a política de backup precisa incluir o Drive compartilhado (Vault/exportação).
- A configuração real depende de acesso administrativo ao Workspace e ao Google Cloud da serventia (P-02, P-03).
