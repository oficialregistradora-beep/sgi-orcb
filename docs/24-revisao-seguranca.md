# Revisão de segurança (Fase 6)

**Data:** 23/10/2026 · **Escopo:** todo o código do branch `fase-6`, servidor de homologação local com dados fictícios.
**Natureza:** autoavaliação técnica orientada pelo OWASP ASVS 4.0 (nível 2), feita pela equipe de desenvolvimento. **Não é certificação nem teste de intrusão independente.** Recomenda-se, antes ou logo após a produção, um teste de intrusão por terceiro — decisão e contratação da serventia.

## Como foi verificado
| Verificação | Ferramenta | Resultado |
|---|---|---|
| Todas as páginas internas exigem sessão; todas as APIs recusam anônimo; rotina agendada exige segredo | `tests/e2e/security-probe.mjs` (varre `app/` e testa cada rota) | 38 páginas e 11 APIs: recusam |
| Cabeçalhos (CSP com nonce, HSTS, nosniff, X-Frame-Options, Referrer/Permissions-Policy), sem identificação do servidor | sondagem | Aprovado |
| Cookie de sessão HttpOnly/SameSite; `Secure` e prefixo `__Host-` em produção (configuração) | sondagem + `session.ts` | Aprovado (Secure depende de HTTPS em produção) |
| Logout invalida a sessão no servidor (cookie copiado deixa de funcionar) | sondagem | Aprovado |
| CSRF: escrita na API e Server Actions com origem externa | sondagem + E2E | Recusadas (403) |
| Acesso cruzado (IDOR) às telas de detalhe de todos os módulos por colaborador sem relação | sondagem (23 telas colhidas como Oficial) | Recusado com 403/404 |
| Todas as consultas de todos os módulos × todos os perfis sobre a carga completa | `round2/phase6-role-matrix.test.ts` (66 consultas × 9 perfis) | Sem erros inesperados; colaborador recusado em 26 consultas de gestão |
| Injeção de SQL | varredura de todas as consultas (`sqlscan`) | 100% parametrizado; interpolações apenas de constantes e marcadores gerados |
| XSS | busca por `dangerouslySetInnerHTML`, `eval`, `new Function` + CSP | Nenhum uso; React escapa a saída |
| Segredos no repositório | busca por chaves privadas, chaves Google, tokens | Nenhum |
| Dependências | `npm audit` (produção e desenvolvimento) | 0 vulnerabilidades (vitest atualizado para 5.0.5) |
| Força bruta no MFA | revisão + testes da rodada 2 | Bloqueio temporário após falhas; código TOTP não reutilizável (anti-repetição) |
| Integridade | `simulation/phase6-system.test.ts` | Hash de todas as versões, assinaturas e arquivos conferem; cadeia de auditoria íntegra |

## Matriz ASVS (resumo por capítulo)
| Capítulo | Situação | Evidência / observação |
|---|---|---|
| V1 Arquitetura | Atende | Monólito modular; autorização no servidor em cada serviço; regras críticas também no banco (CHECK/gatilhos) — ADR 0001–0003 |
| V2 Autenticação | Atende (produção depende de P-03) | Google OIDC + TOTP obrigatório; reautenticação para atos sensíveis; bloqueio por tentativas; login de homologação desligado em produção |
| V3 Sessão | Atende | Token aleatório, hash no banco, limite absoluto e por inatividade, revogação imediata, invalidação no logout |
| V4 Controle de acesso | Atende | RBAC com escopo (próprio/setor/todos), segregação de funções, negação por padrão; matriz de perfis e sondagem IDOR |
| V5 Validação/codificação | Atende | Zod em todas as entradas; SQL parametrizado; React; CSP com nonce |
| V6 Criptografia | Atende | Dados sensíveis cifrados (AES-GCM) com chave fora do código; HMAC para busca; segredo TOTP cifrado |
| V7 Erros e registros | Atende | Mensagens públicas sem detalhes internos; trilha de auditoria encadeada por hash, verificável |
| V8 Proteção de dados | Atende (LGPD depende de J-10/P-06) | Minimização, escopos, avisos sem conteúdo sensível, confidencialidade de documentos, avaliações e incidentes |
| V9 Comunicação | Depende da infraestrutura | HTTPS/HSTS no Cloud Run (P-02); banco com SSL em produção |
| V10 Código malicioso | Atende | Dependências mínimas e fixadas; auditoria de dependências |
| V12 Arquivos | Atende | Tipo pelo conteúdo, tamanho máximo, nome saneado, antivírus com falha fechada, download com `Content-Disposition: attachment`, `nosniff` e CSP restritiva |
| V13 API | Atende | Autenticação, origem e limites de taxa nas rotas |
| V14 Configuração | Atende (produção depende de P-02) | Configuração validada na inicialização; substituições de endereço proibidas em produção; segredos via Secret Manager |

## Achados desta revisão e tratamento
| # | Achado | Gravidade | Tratamento |
|---|---|---|---|
| S-1 | Painel da **coordenação** falhava (erro 500) para perfis com escopo de setor: consulta reaproveitava a lista de parâmetros da anterior (defeito desde a Fase 1, não coberto porque os testes de tela usavam Oficial, Substituta e colaboradores) | Média (indisponibilidade parcial; sem exposição de dados) | Corrigido; criado o teste de matriz de perfis × consultas, que reproduz o defeito sem a correção |
| S-2 | Recusas de acesso em telas respondiam **500** em vez de 403/404 | Baixa (acesso já era negado) | Páginas envolvidas por `withGuard`: 403 para sem permissão, 404 para inexistente/identificador inválido |
| S-3 | Dependência de desenvolvimento (vitest) com avisos publicados | Baixa (não vai para produção) | Atualizada para 5.0.5; suíte completa aprovada |
| S-4 | Contraste de cor e acessibilidade (ver relatório de acessibilidade) | — | Corrigido; 0 violações |

## Riscos residuais e dependências para produção
- Configuração de produção ainda não existe (P-02/P-03): HTTPS, cookies `Secure`, Secret Manager, `CRON_SECRET`, backups do Cloud SQL — ver `26-checklist-producao.md`.
- Teste de intrusão independente não realizado.
- LGPD: RIPD, bases legais e encarregado pendentes (J-10, P-06).
- Ambiente de homologação local usa a base de assinaturas de **teste** do ClamAV (rede bloqueada); a imagem oficial atualiza sozinha em produção.
