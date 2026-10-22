# Arquitetura

## Visão de implantação
```
Navegador ──HTTPS──▶ Cloud Run (container Next.js, 0–2 instâncias, southamerica-east1)
                        │  proxy.ts: CSP com nonce, redirecionamento sem sessão
                        │  app/: telas (Server Components) + Server Actions + /api/v1
                        │  src/server: auth · authz · audit · crypto · modules/*
                        │  src/domain: regras puras (tempo, jornada, banco de horas)
                        ├──TLS──▶ Cloud SQL PostgreSQL 16 (backups diários + PITR)
                        ├──HTTPS▶ Google OIDC (login) · [Fase 3–4] Drive, Calendar, Chat, Gmail
                        └──────▶ Secret Manager (chaves de campo, HMAC, OAuth)
```

## Camadas
| Camada | Pasta | Responsabilidade | Regra |
|---|---|---|---|
| Domínio | `src/domain` | Cálculo de jornada, tolerância, alertas, PEPS, vencimento, custo | Sem I/O; 100% testável por unidade |
| Serviços | `src/server/modules` | Casos de uso; transações; auditoria; **autorização** | Toda função pública recebe `Ctx` e chama `requirePermission`/`getEmployeeFor` |
| Infraestrutura | `src/server/{db,auth,crypto,totp,audit,settings}` | Banco, sessões, MFA, criptografia | — |
| Web | `app/`, `src/server/web`, `src/ui` | Telas, Server Actions, API REST | Nenhuma regra de negócio; a UI apenas oculta o que o servidor já bloqueia |

## Fluxo de autenticação
1. `/api/auth/google/start` gera `state`, `nonce` e o verificador PKCE, guardados em cookie assinado (10 min, httpOnly).
2. O Google retorna em `/api/auth/google/callback`: o sistema troca o código, valida o ID token (JWKS, `iss`, `aud`, `exp`, `nonce`, `email_verified`, `hd`) e busca o usuário **pré-cadastrado e ativo**. Caso contrário, o acesso é negado e auditado.
3. Cria-se a sessão no servidor (token aleatório de 256 bits; só o hash SHA-256 é gravado) e o cookie `__Host-sgi_sessao` (httpOnly, Secure, SameSite=Lax).
4. `/mfa`: cadastro (QR) ou verificação TOTP. A sessão só fica utilizável após o segundo fator.
5. A cada requisição são verificados revogação, inatividade (30 min), limite absoluto (12 h) e situação do usuário.
6. Operações críticas exigem `step_up_at` recente (10 min), e a interface abre o diálogo do código automaticamente.

## Proteções transversais
CSP com nonce e `strict-dynamic`, `frame-ancestors 'none'`, HSTS, nosniff, Referrer-Policy, Permissions-Policy · Server Actions com verificação de origem nativa do Next; rotas POST com verificação explícita de `Origin` · consultas 100% parametrizadas · validação de entrada com Zod · mensagens de erro sem detalhes internos · advisory locks contra condições de corrida (marcação, banco de horas, apuração, assinatura).

## Decisões
Ver `docs/adr/0001` a `0007`.
