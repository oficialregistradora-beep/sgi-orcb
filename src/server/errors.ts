/** Erros de domínio com mensagens seguras para exibição ao usuário. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 400, code = 'ERRO_VALIDACAO') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class AuthRequiredError extends AppError {
  constructor(message = 'Autenticação necessária.') {
    super(message, 401, 'NAO_AUTENTICADO');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Você não tem permissão para esta operação.') {
    super(message, 403, 'SEM_PERMISSAO');
  }
}

export class StepUpRequiredError extends AppError {
  constructor(message = 'Esta operação exige reautenticação com o código do autenticador.') {
    super(message, 403, 'REAUTENTICACAO_NECESSARIA');
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Registro não encontrado.') {
    super(message, 404, 'NAO_ENCONTRADO');
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, 'CONFLITO');
  }
}

/** Converte qualquer erro em mensagem exibível, sem vazar detalhes internos. */
export function publicMessage(err: unknown): string {
  if (err instanceof AppError) return err.message;
  if (err && typeof err === 'object' && 'issues' in err) {
    const issues = (err as { issues: { path: PropertyKey[]; message: string }[] }).issues;
    return issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
  }
  return 'Erro inesperado. A ocorrência foi registrada.';
}
