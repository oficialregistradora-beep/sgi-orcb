import { z } from 'zod';

const base64Key = z
  .string()
  .min(1)
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'deve conter 32 bytes em base64');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.url(),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: z.enum(['true', 'false']).default('false'),
  GOOGLE_WORKSPACE_DOMAIN: z.string().min(3),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  FIELD_ENCRYPTION_KEY: base64Key,
  HMAC_KEY: base64Key,
  AUTH_DEV_LOGIN: z.enum(['true', 'false']).default('false'),
});

export type AppConfig = {
  env: 'development' | 'test' | 'production';
  appUrl: string;
  secureCookies: boolean;
  databaseUrl: string;
  databaseSsl: boolean;
  workspaceDomain: string;
  googleClientId: string;
  googleClientSecret: string;
  googleConfigured: boolean;
  fieldKey: Buffer;
  hmacKey: Buffer;
  devLogin: boolean;
};

let cached: AppConfig | null = null;

/** Lê e valida as variáveis de ambiente. Falha imediatamente em configurações inseguras. */
export function getConfig(): AppConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuração inválida: ${issues}`);
  }
  const e = parsed.data;
  const devLogin = e.AUTH_DEV_LOGIN === 'true';
  if (e.NODE_ENV === 'production' && devLogin) {
    throw new Error('AUTH_DEV_LOGIN não pode ser habilitado em produção.');
  }
  if (e.NODE_ENV === 'production' && !e.APP_URL.startsWith('https://')) {
    throw new Error('APP_URL deve usar HTTPS em produção.');
  }
  cached = {
    env: e.NODE_ENV,
    appUrl: e.APP_URL.replace(/\/$/, ''),
    secureCookies: e.APP_URL.startsWith('https://'),
    databaseUrl: e.DATABASE_URL,
    databaseSsl: e.DATABASE_SSL === 'true',
    workspaceDomain: e.GOOGLE_WORKSPACE_DOMAIN.toLowerCase(),
    googleClientId: e.GOOGLE_CLIENT_ID,
    googleClientSecret: e.GOOGLE_CLIENT_SECRET,
    googleConfigured: e.GOOGLE_CLIENT_ID.length > 0 && e.GOOGLE_CLIENT_SECRET.length > 0,
    fieldKey: Buffer.from(e.FIELD_ENCRYPTION_KEY, 'base64'),
    hmacKey: Buffer.from(e.HMAC_KEY, 'base64'),
    devLogin,
  };
  return cached;
}

/** Somente para testes. */
export function resetConfigCache(): void {
  cached = null;
}
