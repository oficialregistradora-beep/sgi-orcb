# Inventário de dependências e licenças

Política: o mínimo de dependências, todas de código aberto e mantidas, com versões fixadas (`package-lock.json`). Nenhuma licença paga.

| Pacote | Versão | Uso | Licença |
|---|---|---|---|
| next | 16.4.0 | Framework web | MIT |
| react / react-dom | 19.3.0 | Interface | MIT |
| pg | 8.23.1 | Driver PostgreSQL | MIT |
| jose | 6.2.12 | Verificação do ID token (JWT/JWKS) | MIT |
| zod | 4.6.5 | Validação de entradas e configuração | MIT |
| qrcode | 1.5.4 | QR Code do cadastro do autenticador | MIT |
| typescript (dev) | 5.9.3 | Tipagem | Apache-2.0 |
| vitest (dev) | 3.2.7 | Testes | MIT |
| playwright-core (dev) | 1.56.1 | Teste ponta a ponta | Apache-2.0 |
| @types/* (dev) | — | Tipos | MIT |

Serviços: PostgreSQL 16 (PostgreSQL License), Google Cloud (contratação a aprovar), Google Workspace (já contratado). Fontes: pilha do sistema (sem download). Ícones e marca: criação própria.

Observação: o vitest 4.1 falhou na instalação por um defeito de resolução de dependências opcionais do npm 10.9; por isso foi adotada a linha 3.2 (estável).
