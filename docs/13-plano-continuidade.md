# Plano de continuidade e recuperação de desastres (sistema de gestão interna)

> O SGI-ORCB **não** contém o acervo registral nem substitui os sistemas oficiais. Sua indisponibilidade não interrompe a prática de atos; afeta controles internos.

| Cenário | Impacto | Contingência | RTO / RPO alvo |
|---|---|---|---|
| Indisponibilidade da aplicação | Sem marcação eletrônica | Folha de frequência em papel (modelo anexo a elaborar), lançada depois por correção com justificativa "contingência" | 4 h / 0 |
| Falha do banco | Idem | Failover/restauração do Cloud SQL (PITR) | 4 h / 5 min |
| Exclusão ou corrupção lógica | Dados incorretos | PITR para o instante anterior | 8 h / 5 min |
| Perda da região GCP | Indisponibilidade prolongada | Restaurar o backup lógico em outra região ou em VM (docker-compose) | 48 h / 7 dias (semanal) — reduzir com exportação diária se desejado |
| Indisponibilidade do Google (login) | Sem acesso | Aguardar; procedimento de exceção com conta de emergência da Oficial, a definir | — |
| Comprometimento de credenciais | Risco de acesso indevido | Suspender usuários, rotacionar segredos, revisar auditoria | Imediato |
| Perda da chave de criptografia | Campos sensíveis ilegíveis | Cópia de custódia da chave (obrigatória) | — |

Testes: restauração trimestral; simulação anual de indisponibilidade com a folha em papel.
