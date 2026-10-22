import { z } from 'zod';

const base64Key = z
  .string()
  .min(1)
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'deve conter 32 bytes em base64');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Ambiente institucional (independe do modo de build). Em build de produção, o padrão é 'producao'.
  APP_ENV: z.enum(['desenvolvimento', 'homologacao', 'producao']).optional(),
  APP_URL: z.url(),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: z.enum(['true', 'false']).default('false'),
  GOOGLE_WORKSPACE_DOMAIN: z.string().min(3),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  FIELD_ENCRYPTION_KEY: base64Key,
  HMAC_KEY: base64Key,
  AUTH_DEV_LOGIN: z.enum(['true', 'false']).default('false'),
  // Antivírus (ClamAV/clamd). Em produção, sem antivírus configurado, anexos são recusados.
  CLAMAV_HOST: z.string().default(''),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  CLAMAV_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
  // Armazenamento dos arquivos documentais: banco (padrão) ou Google Drive compartilhado.
  DOCUMENT_STORAGE: z.enum(['banco', 'drive']).default('banco'),
  GOOGLE_DRIVE_SHARED_DRIVE_ID: z.string().default(''),
  GOOGLE_DRIVE_FOLDER_ID: z.string().default(''),
  // Chave JSON da conta de serviço em base64. Opcional no Cloud Run (usa a identidade do serviço, sem chave).
  GOOGLE_DRIVE_SA_KEY: z.string().default(''),
  GOOGLE_DRIVE_API_URL: z.url().default('https://www.googleapis.com'),
  GOOGLE_OAUTH_TOKEN_URL: z.url().default('https://oauth2.googleapis.com/token'),
});

export type AppConfig = {
  env: 'development' | 'test' | 'production';
  appEnv: 'desenvolvimento' | 'homologacao' | 'producao';
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
  clamav: { host: string; port: number; timeoutMs: number } | null;
  storage: 'banco' | 'drive';
  drive: { sharedDriveId: string; folderId: string; saKey: string; apiUrl: string; tokenUrl: string };
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
  const appEnv = e.APP_ENV ?? (e.NODE_ENV === 'production' ? 'producao' : 'desenvolvimento');
  const devLogin = e.AUTH_DEV_LOGIN === 'true';
  if (appEnv === 'producao' && devLogin) {
    throw new Error('AUTH_DEV_LOGIN não pode ser habilitado em produção (APP_ENV=producao).');
  }
  if (appEnv === 'producao' && !e.APP_URL.startsWith('https://')) {
    throw new Error('APP_URL deve usar HTTPS em produção.');
  }
  if (e.DOCUMENT_STORAGE === 'drive' && !e.GOOGLE_DRIVE_SHARED_DRIVE_ID) {
    throw new Error('DOCUMENT_STORAGE=drive exige GOOGLE_DRIVE_SHARED_DRIVE_ID.');
  }
  if (appEnv === 'producao' && (e.GOOGLE_DRIVE_API_URL !== 'https://www.googleapis.com' || e.GOOGLE_OAUTH_TOKEN_URL !== 'https://oauth2.googleapis.com/token')) {
    throw new Error('Endereços da API do Google não podem ser substituídos em produção.');
  }
  cached = {
    env: e.NODE_ENV,
    appEnv,
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
    clamav: e.CLAMAV_HOST ? { host: e.CLAMAV_HOST, port: e.CLAMAV_PORT, timeoutMs: e.CLAMAV_TIMEOUT_MS } : null,
    storage: e.DOCUMENT_STORAGE,
    drive: {
      sharedDriveId: e.GOOGLE_DRIVE_SHARED_DRIVE_ID, folderId: e.GOOGLE_DRIVE_FOLDER_ID, saKey: e.GOOGLE_DRIVE_SA_KEY,
      apiUrl: e.GOOGLE_DRIVE_API_URL.replace(/\/$/, ''), tokenUrl: e.GOOGLE_OAUTH_TOKEN_URL,
    },
  };
  return cached;
}

/** Somente para testes. */
export function resetConfigCache(): void {
  cached = null;
}
