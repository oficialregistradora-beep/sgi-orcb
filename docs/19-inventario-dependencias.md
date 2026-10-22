# Inventário de dependências e licenças

Política: o mínimo de dependências, todas de código aberto e mantidas, com versões fixadas (`package-lock.json`). Nenhuma licença paga.

| Pacote | Versão | Uso | Licença |
|---|---|---|---|
| next | 16.4.2 | Framework web | MIT |
| react / react-dom | 19.3.0 | Interface | MIT |
| pg | 8.23.1 | Driver PostgreSQL | MIT |
| jose | 6.2.12 | Verificação do ID token (JWT/JWKS) e assinatura do JWT da conta de serviço do Drive | MIT |
| zod | 4.6.5 | Validação de entradas e configuração | MIT |
| qrcode | 1.5.4 | QR Code do cadastro do autenticador | MIT |
| typescript (dev) | 5.9.3 | Tipagem | Apache-2.0 |
| vitest (dev) | 3.2.7 | Testes | MIT |
| playwright-core (dev) | 1.56.1 | Teste ponta a ponta | Apache-2.0 |
| @types/* (dev) | — | Tipos | MIT |

Serviços: PostgreSQL 16 (PostgreSQL License), ClamAV 1.4 — imagem `clamav/clamav` (GPL-2.0, executado como serviço separado, sem vínculo de código com a aplicação), Google Drive API (opcional, incluída no Workspace), Google Cloud (contratação a aprovar), Google Workspace (já contratado). Fontes: pilha do sistema (sem download). Ícones e marca: criação própria.

Observação: o vitest 4.1 falhou na instalação por um defeito de resolução de dependências opcionais do npm 10.9; por isso foi adotada a linha 3.2 (estável).

**Registro de segurança (22/10/2026):** a versão 16.4.0 do Next.js, adotada no início do projeto, passou a constar com vulnerabilidades críticas (GHSA-2464-fhr4-w9xw, GHSA-p3m5-59mp-jv5r, GHSA-673q-mjm6-r5xr). O build passou a ser bloqueado e o `npm audit` as confirmou. A dependência foi atualizada para a 16.4.2 (correção). Depois disso, `npm audit --omit=dev` retornou 0 vulnerabilidades, e todos os testes foram reexecutados com aprovação. Rotina: rodar `npm audit` a cada atualização e mensalmente (plano de manutenção).
