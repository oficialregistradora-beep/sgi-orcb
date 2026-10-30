'use client';

import { startTransition, useActionState, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ActionState } from '../server/web/action.ts';
import { stepUpAction } from '../../app/actions/auth.ts';
import { EmailCodeButton } from './EmailCodeButton.tsx';

type Props = {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  children: ReactNode;
  submitLabel?: string;
  submitClass?: string;
  confirm?: string;
  resetOnSuccess?: boolean;
  className?: string;
  inline?: boolean;
};

export function SubmitButton({ label, className = 'btn btn-primary', pending }: { label: string; className?: string; pending: boolean }) {
  return (
    <button type="submit" className={className} disabled={pending} aria-busy={pending}>
      {pending ? 'Processando…' : label}
    </button>
  );
}

/**
 * Formulário ligado a uma Server Action. Exibe o resultado e, quando o servidor exige reautenticação,
 * abre o diálogo do código do autenticador e reenvia o formulário após a confirmação.
 * O envio é feito pelo onSubmit (e não por `<form action>`): assim o React não limpa os campos quando o servidor
 * recusa (erro ou reautenticação) — só `resetOnSuccess` limpa, e apenas após sucesso.
 */
export function ActionForm({ action, children, submitLabel = 'Salvar', submitClass, confirm, resetOnSuccess, className, inline }: Props) {
  const [state, formAction, pending] = useActionState(action, { ok: true, message: '' });
  const formRef = useRef<HTMLFormElement>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [stepUpError, setStepUpError] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (state.stepUp) {
      setStepUpOpen(true);
      setStepUpError('');
      setCode('');
    }
    if (state.ok && state.message && resetOnSuccess) formRef.current?.reset();
  }, [state, resetOnSuccess]);

  async function confirmStepUp() {
    setBusy(true);
    const r = await stepUpAction(code);
    setBusy(false);
    if (!r.ok) {
      setStepUpError(r.message);
      return;
    }
    setStepUpOpen(false);
    formRef.current?.requestSubmit();
  }

  return (
    <>
      <form
        ref={formRef}
        className={className}
        onSubmit={(e) => {
          e.preventDefault();
          if (pending || (confirm && !window.confirm(confirm))) return;
          const fd = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter);
          startTransition(() => formAction(fd));
        }}
      >
        {children}
        <div className={inline ? 'row' : 'form-actions'}>
          {state.message && !state.stepUp ? (
            <span role="status" className={`small ${state.ok ? 'pos' : 'neg'}`} key={state.at}>
              {state.message}
            </span>
          ) : null}
          <SubmitButton label={submitLabel} className={submitClass} pending={pending} />
        </div>
      </form>
      {stepUpOpen ? (
        <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="stepup-title">
          <div className="card dialog">
            <div className="card-head">
              <h2 id="stepup-title">Confirme sua identidade</h2>
            </div>
            <div className="card-body stack">
              <p className="muted small">Operação crítica: informe o código do aplicativo autenticador, um código de reserva ou o código enviado ao seu e-mail pessoal.</p>
              <input
                className="input mono"
                autoComplete="one-time-code"
                maxLength={9}
                autoFocus
                aria-label="Código de confirmação"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void confirmStepUp();
                  }
                }}
              />
              {stepUpError ? <p className="small neg" role="alert">{stepUpError}</p> : null}
              <EmailCodeButton />
              <div className="form-actions">
                <button type="button" className="btn" onClick={() => setStepUpOpen(false)}>Cancelar</button>
                <button type="button" className="btn btn-primary" disabled={code.replace(/-/g, '').length < 6 || busy} onClick={() => void confirmStepUp()}>
                  {busy ? 'Verificando…' : 'Confirmar'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
