'use client';

import { useState } from 'react';
import { emailCodeAction } from '../../app/actions/auth.ts';

/** Pede o código de acesso no e-mail pessoal (só funciona para quem a Oficial liberou). */
export function EmailCodeButton({ label = 'Enviar código para meu e-mail pessoal' }: { label?: string }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="small">
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const r = await emailCodeAction();
          setBusy(false);
          setMsg({ ok: r.ok, text: r.message });
        }}
      >
        {busy ? 'Enviando…' : label}
      </button>
      {msg ? <p role="status" className={msg.ok ? 'pos' : 'neg'}>{msg.text}</p> : null}
    </div>
  );
}
