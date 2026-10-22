# ADR 0007 — APP_ENV separado de NODE_ENV

`next start` sempre usa NODE_ENV=production. Para permitir homologação com usuários fictícios em build de produção, o ambiente institucional é definido por `APP_ENV` (desenvolvimento | homologacao | producao). Na ausência de `APP_ENV` em build de produção, assume-se **producao**, e a aplicação **recusa iniciar** se `AUTH_DEV_LOGIN=true` ou se `APP_URL` não usar HTTPS.
