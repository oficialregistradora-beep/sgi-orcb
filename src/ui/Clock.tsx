'use client';

import { useEffect, useState } from 'react';

const fmt = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dfmt = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: 'long' });

/** Relógio informativo. A marcação usa SEMPRE o horário do servidor, não o do computador. */
export function Clock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div>
      <div className="clock" aria-live="off">{now ? fmt.format(now) : '--:--:--'}</div>
      <div className="muted small" style={{ marginTop: 6 }}>{now ? capitalize(dfmt.format(now)) : ''}</div>
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
