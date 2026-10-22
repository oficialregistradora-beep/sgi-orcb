# ADR 0009 — Repositório documental: armazenamento, acesso e ciclo de vida

**Situação:** aceita (Fase 3, 22/10/2026).

## Armazenamento dos arquivos
- Os arquivos ficam no **PostgreSQL** (`document_files.data`, bytea), identificados por **SHA-256** conferido na aprovação e em cada download. Motivos: uma única cópia de segurança (o backup do banco já inclui os arquivos), uma única via de acesso (a rota autorizada), nenhum serviço adicional a contratar e volume pequeno (serventia com menos de 20 pessoas; limite de 15 MB por arquivo, configurável).
- **Google Drive: não integrado nesta fase** (Dependente de configuração — P-03). O requisito §13 alerta que ocultar um documento na interface não impede o acesso direto ao arquivo. Com o armazenamento no banco, não existe link externo: o arquivo só sai pela rota `/api/v1/documentos/{id}/arquivo/{versão}`, que verifica sessão, MFA, público, confidencialidade e hash. Se o Drive vier a ser adotado, a proposta é um Drive compartilhado sem membros humanos, acessado por conta de serviço com escopo mínimo, e o sistema servindo os arquivos como intermediário (as permissões nativas do Drive nunca seriam a única barreira).
- Reavaliar quando o acervo passar de alguns GB: armazenamento de objetos (Cloud Storage) com URLs assinadas de curta duração, mantendo o hash no banco.

## Acesso
- **Público destinatário:** todos, setores ou pessoas. **Interno** pode ir a todos; **Restrito** exige setores ou pessoas; **Confidencial** exige pessoas nominalmente indicadas e **não é alcançado pela permissão de gestão** — apenas Oficial, responsável, autor e pessoas da lista.
- Quem não tem acesso recebe "não encontrado" (não se revela a existência do documento).
- Rascunhos, versões anteriores e histórico: somente quem edita (no escopo do setor), aprova, gere, o responsável e o autor.

## Ciclo de vida
Rascunho (editável) → submissão (gera versão **imutável** com hash) → aprovação por **outra pessoa** (nunca quem elaborou ou submeteu), com assinatura eletrônica simples e reautenticação → vigente (a anterior fica superada) → obsoleto ou arquivado. A rejeição exige motivo e devolve o conteúdo ao rascunho. A revisão periódica é calculada na aprovação e avisada uma vez ao responsável.

## Retenção e descarte
Nenhum prazo de retenção foi presumido. Sem prazo registrado (com fundamento) na categoria, o descarte fica **bloqueado**. O descarte elimina apenas o **conteúdo dos arquivos**; metadados, hashes, versões, assinaturas e histórico permanecem. O texto digitado nas versões não é descartável (faz parte da trilha imutável): conteúdo sujeito a descarte deve ser anexado como arquivo.

## Limitações registradas
Sem verificação antivírus dos anexos (os formatos são restritos por lista fechada e conferidos pelo conteúdo; download sempre como anexo, com `nosniff` e CSP `sandbox`). Sem pré-visualização de PDF no navegador. Vigência futura (aprovar hoje para valer depois) não implementada: a versão aprovada vigora na data da aprovação.
