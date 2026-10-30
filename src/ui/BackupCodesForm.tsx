'use client';

import { startTransition, useActionState } from 'react';
import { backupCodesAction, type BackupCodesState } from '../../app/actions/auth.ts';
import { SubmitButton } from './ActionForm.tsx';

/** Gera os códigos de reserva e os mostra uma única vez, para imprimir ou anotar. */
export function BackupCodesForm({ hasCodes }: { hasCodes: boolean }) {
  const [state, action, pending] = useActionState<BackupCodesState, FormData>(backupCodesAction, { ok: true, message: '' });
  return (
    <div className="stack">
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (hasCodes && !window.confirm('Os códigos atuais deixarão de valer. Continuar?')) return;
          const fd = new FormData(e.currentTarget);
          startTransition(() => action(fd));
        }}
      >
        <div className="field">
          <label htmlFor="bc-code">Código atual (autenticador, e-mail ou um código de reserva)</label>
          <input id="bc-code" name="code" className="input mono" autoComplete="one-time-code" maxLength={9} required />
        </div>
        <div className="form-actions">
          {state.message ? <span role="status" className={`small ${state.ok ? 'pos' : 'neg'}`} key={state.at}>{state.message}</span> : null}
          <SubmitButton label={hasCodes ? 'Gerar novos códigos' : 'Gerar códigos de reserva'} pending={pending} />
        </div>
      </form>
      {state.codes ? (
        <div className="alert alert-warn">
          <div className="stack">
            <strong>Anote ou imprima agora: estes códigos não serão mostrados de novo.</strong>
            <ol className="mono" style={{ columns: 2, margin: 0 }}>{state.codes.map((c) => <li key={c}>{c}</li>)}</ol>
            <p className="small">Cada código funciona uma única vez. Guarde em lugar seguro (carteira, gaveta pessoal com chave); não fotografe nem envie por mensagem.</p>
            <div><button type="button" className="btn btn-sm" onClick={() => window.print()}>Imprimir</button></div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
