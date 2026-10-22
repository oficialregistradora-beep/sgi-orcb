'use client';

import { useActionState, useEffect, useRef, useState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import type { ActionState } from '../server/web/action.ts';
import { stepUpAction } from '../../app/actions/auth.ts';

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

export function SubmitButton({ label, className = 'btn btn-primary' }: { label: string; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending} aria-busy={pending}>
      {pending ? 'Processando…' : label}
    </button>
  );
}

/**
 * Formulário ligado a uma Server Action. Exibe o resultado e, quando o servidor exige reautenticação,
 * abre o diálogo do código do autenticador e reenvia o formulário após a confirmação.
 */
export function ActionForm({ action, children, submitLabel = 'Salvar', submitClass, confirm, resetOnSuccess, className, inline }: Props) {
  const [state, formAction] = useActionState(action, { ok: true, message: '' });
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
        action={formAction}
        className={className}
        onSubmit={(e) => {
          if (confirm && !window.confirm(confirm)) e.preventDefault();
        }}
      >
        {children}
        <div className={inline ? 'row' : 'form-actions'}>
          {state.message && !state.stepUp ? (
            <span role="status" className={`small ${state.ok ? 'pos' : 'neg'}`} key={state.at}>
              {state.message}
            </span>
          ) : null}
          <SubmitButton label={submitLabel} className={submitClass} />
        </div>
      </form>
      {stepUpOpen ? (
        <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="stepup-title">
          <div className="card dialog">
            <div className="card-head">
              <h2 id="stepup-title">Confirme sua identidade</h2>
            </div>
            <div className="card-body stack">
              <p className="muted small">Operação crítica: informe o código de 6 dígitos do seu aplicativo autenticador.</p>
              <input
                className="input mono"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                autoFocus
                aria-label="Código do autenticador"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void confirmStepUp();
                  }
                }}
              />
              {stepUpError ? <p className="small neg" role="alert">{stepUpError}</p> : null}
              <div className="form-actions">
                <button type="button" className="btn" onClick={() => setStepUpOpen(false)}>Cancelar</button>
                <button type="button" className="btn btn-primary" disabled={code.length !== 6 || busy} onClick={() => void confirmStepUp()}>
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
