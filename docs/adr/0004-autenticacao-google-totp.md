# ADR 0004 — Login Google Workspace (OIDC + PKCE) e MFA TOTP próprio

**Contexto.** O Google não informa de forma confiável, no ID token, se o segundo fator foi usado (claim `amr` ausente para contas Workspace).
**Decisão.** OIDC (authorization code + PKCE, `state`, `nonce`, verificação do domínio pela claim `hd`) e segundo fator TOTP (RFC 6238) obrigatório no próprio sistema, com anti-reuso e bloqueio após 5 falhas. A reautenticação para operações críticas exige novo código TOTP (validade configurável, padrão de 10 min). **Recomenda-se também** exigir a verificação em duas etapas no Admin Console do Workspace (dependente de configuração).
**Consequências.** O MFA independe da edição do Workspace. A perda do celular exige redefinição pelo administrador (ação auditada).
