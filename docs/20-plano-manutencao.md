# Plano de manutenção

| Atividade | Frequência | Detalhe |
|---|---|---|
| Atualizações de segurança (npm audit, Node, Next, pg) | Mensal / imediata se crítica | Rodar todas as rodadas de teste antes de publicar |
| Atualização de versão do PostgreSQL | Anual | Teste de restauração antes e depois |
| Teste de restauração | Trimestral | `scripts/backup-restore-test.sh` + relatório |
| Verificação da cadeia de auditoria | Mensal | Tela de Auditoria |
| Revisão de permissões e usuários ativos | Trimestral | Oficial |
| Revisão de parâmetros jurídicos (CCT, tolerância, adicional) | Na data-base da CCT ou em mudança legislativa | Advogado(a) |
| Feriados do ano seguinte | Novembro | Configurações → Feriados |
| Rotação de segredos (OAuth, HMAC) | Anual ou em incidente | A chave de campo exige recifragem (script a desenvolver) |

Mudanças de código: branch → testes automatizados → revisão → homologação → publicação autorizada. Migrations nunca são editadas depois de aplicadas; criam-se novas.
