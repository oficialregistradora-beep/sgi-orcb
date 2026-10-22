// Ambiente de testes: banco dedicado (sgi_test) e chaves fictícias. Nenhum dado real é utilizado.
(process.env as Record<string, string>).NODE_ENV = 'test';
process.env.APP_URL = 'http://localhost:3000';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://sgi:sgi_dev_local@localhost:5432/sgi_test';
process.env.DATABASE_SSL = 'false';
process.env.GOOGLE_WORKSPACE_DOMAIN = 'cartorio-teste.example';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.FIELD_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.HMAC_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.AUTH_DEV_LOGIN = 'false';
