'use server';

import { runAction, str, int, type ActionState } from '@/server/web/action.ts';
import { AppError } from '@/server/errors.ts';
import { localToInstant } from '@/domain/time.ts';
import { addNetworkException, revokeNetworkException, saveNetworkConfig } from '@/server/modules/network.ts';

export async function networkAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    switch (str(fd, 'op')) {
      case 'config': {
        const r = await saveNetworkConfig(ctx, { active: fd.get('active') === 'on', ipsText: str(fd, 'ips'), punchInternal: fd.get('punchInternal') === 'on', oncallSlack: int(fd, 'oncallSlack') || 0 });
        return r.currentIpInside ? 'Configuração de rede salva.' : 'Configuração salva. Atenção: o endereço de onde você está agora NÃO está na lista.';
      }
      case 'liberar': {
        const [d, t] = str(fd, 'validUntil').split('T');
        if (!d || !t) throw new AppError('Informe data e hora.');
        await addNetworkException(ctx, { userId: str(fd, 'userId'), validUntil: localToInstant(d, t.slice(0, 5)), reason: str(fd, 'reason') });
        return 'Acesso externo liberado.';
      }
      case 'revogar': await revokeNetworkException(ctx, str(fd, 'id')); return 'Liberação revogada.';
      default: throw new AppError('Operação desconhecida.');
    }
  }, '/configuracoes');
}
