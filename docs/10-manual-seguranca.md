# Manual de segurança e proteção de dados

## Controles técnicos implementados (referência: OWASP ASVS 4.x — verificação formal pendente)
| Área | Controle | Onde |
|---|---|---|
| Autenticação | OIDC Google + PKCE, state, nonce, restrição de domínio (`hd`), usuários pré-cadastrados | `auth/google.ts` |
| MFA | TOTP RFC 6238, segredo cifrado, anti-reuso atômico, bloqueio após 5 falhas | `auth/mfa.ts`, `totp.ts` |
| Sessão | Token de 256 bits (somente o hash fica gravado), cookie `__Host-` httpOnly/Secure/SameSite, inatividade de 30 min, limite de 12 h, revogação imediata | `auth/session.ts` |
| Reautenticação | Código TOTP para operações críticas (10 min) | `authz.requireStepUp` |
| Autorização | Verificação no servidor em todo serviço; escopo próprio/setor/todos; proteção contra IDOR; segregação de funções | `authz.ts`, módulos |
| Entradas | Validação com Zod; SQL parametrizado; CSV com neutralização de fórmulas | módulos, rota de relatório |
| Navegador | CSP com nonce, frame-ancestors none, HSTS, nosniff, Referrer-Policy, Permissions-Policy, COOP | `proxy.ts`, `next.config.ts` |
| CSRF | Verificação de origem nas Server Actions (nativa) e nas rotas POST (`sameOrigin`) | `web/session.ts` |
| Limitação de taxa | Login: 20/min por IP; API: 120/min por usuário (em memória, por instância) | `ratelimit.ts` |
| Criptografia em repouso | AES-256-GCM por campo para dados sensíveis e segredo TOTP; HMAC para busca de CPF; disco do Cloud SQL criptografado pelo provedor | `crypto.ts` |
| Criptografia em trânsito | HTTPS obrigatório em produção (a aplicação recusa iniciar sem ele); TLS para o banco | `config.ts` |
| Integridade | Tabelas críticas imutáveis; auditoria encadeada por SHA-256; hash de documentos e evidências de assinatura | migrations, `documents.ts` |
| Segregação de ambientes | `APP_ENV`; login de teste e seed proibidos em produção | `config.ts`, `seed.ts` |
| Segredos | Somente variáveis de ambiente / Secret Manager; `.env` fora do Git | `.gitignore` |
| Privilégio no banco | Aplicação com papel `sgi_app` (não dono; sem UPDATE/DELETE nas tabelas imutáveis) | `db/roles.sql` |

**Limitações conhecidas:** limitação de taxa em memória (multiplica-se pelo número de instâncias); rotação da chave de campo exige script de recifragem (o formato `v1.` já prevê versionamento — Pendente); cadastro de dispositivos autorizados não implementado (avaliar o Endpoint Management do Workspace).

## LGPD — inventário inicial (dependente de validação do encarregado — P-06)
| Dado | Finalidade | Base legal provável (validar) | Acesso | Proteção |
|---|---|---|---|---|
| Nome, matrícula, cargo, setor, e-mail institucional | Gestão do vínculo | Execução de contrato (art. 7º, V) | Gestão + titular | Controle de acesso |
| Marcações e apuração | Controle de jornada | Obrigação legal / contrato (art. 7º, II e V) | Titular, coordenação do setor, gestão | Imutável, auditado |
| CPF, RG, endereço, telefone, banco, contato de emergência | Folha e obrigações | Obrigação legal / contrato | Oficial (por padrão) | Cifrado; consulta auditada |
| Observações de saúde (atestados) | Abono e afastamentos | Art. 11, II, "b" (dado sensível) | Oficial | Cifrado; consulta auditada |
| Salário | Folha e custo do banco | Contrato | Oficial | Restrito; consulta auditada |
| IP/navegador em sessões e assinaturas | Segurança e evidência | Legítimo interesse / obrigação legal | Auditoria | — |

Retenção: nenhum expurgo automático foi implementado; prazos a definir por tipo (J-09). Não utilizar dados reais em desenvolvimento ou homologação.

## Resposta a incidentes (resumo)
1. Conter: suspender usuários afetados (revogação imediata) ou retirar o serviço do ar (Cloud Run → 0 instâncias).
2. Preservar: exportar a auditoria e verificar a cadeia; snapshot do banco.
3. Avaliar: escopo dos dados afetados; se houver risco relevante aos titulares, comunicar a ANPD e os titulares (art. 48 da LGPD) e observar as normas do CNJ aplicáveis às serventias.
4. Corrigir, restaurar (ver `12-backup-restauracao.md`) e registrar lições aprendidas.
