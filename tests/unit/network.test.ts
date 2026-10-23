import { describe, expect, it } from 'vitest';
import { ipAllowed, normalizeIp, parseAllowList, parseCidr, pickClientIp } from '../../src/domain/network.ts';

describe('IP do cliente atrás de proxies', () => {
  it('usa o item acrescentado pela infraestrutura, nunca o forjado pelo navegador', () => {
    // Navegador forja "10.0.0.1"; o Cloud Run acrescenta o endereço real ao final.
    expect(pickClientIp('10.0.0.1, 200.1.2.3', null, 0)).toBe('200.1.2.3');
    expect(pickClientIp('200.1.2.3', null, 0)).toBe('200.1.2.3');
    // Com balanceador na frente (1 salto confiável a mais): o penúltimo.
    expect(pickClientIp('10.0.0.1, 200.1.2.3, 34.1.1.1', null, 1)).toBe('200.1.2.3');
    expect(pickClientIp(null, '177.5.5.5', 0)).toBe('177.5.5.5');
    expect(pickClientIp('', null, 0)).toBeNull();
    expect(pickClientIp('1.2.3.4', null, 5)).toBe('1.2.3.4');
  });
  it('normaliza porta, colchetes e IPv4 mapeado em IPv6', () => {
    expect(normalizeIp('200.1.2.3:443')).toBe('200.1.2.3');
    expect(normalizeIp('[2804:14C::1]')).toBe('2804:14c::1');
    expect(normalizeIp('::ffff:200.1.2.3')).toBe('200.1.2.3');
  });
});

describe('Lista de endereços permitidos', () => {
  it('IPv4 exato e faixa', () => {
    const l = parseAllowList('200.1.2.3\n177.10.20.0/24 # reserva');
    expect(ipAllowed('200.1.2.3', l)).toBe(true);
    expect(ipAllowed('200.1.2.4', l)).toBe(false);
    expect(ipAllowed('177.10.20.254', l)).toBe(true);
    expect(ipAllowed('177.10.21.1', l)).toBe(false);
    expect(ipAllowed(null, l)).toBe(false);
    expect(ipAllowed('lixo', l)).toBe(false);
  });
  it('IPv6 com prefixo e forma abreviada', () => {
    const l = parseAllowList('2804:14c:1a2b::/48');
    expect(ipAllowed('2804:14c:1a2b:ffff::9', l)).toBe(true);
    expect(ipAllowed('2804:14c:1a2c::1', l)).toBe(false);
    expect(ipAllowed('200.1.2.3', l)).toBe(false);
    expect(ipAllowed('2804:14c:1a2b::', parseAllowList('2804:14c:1a2b:0:0:0:0:0'))).toBe(true);
  });
  it('recusa entradas inválidas e faixas amplas demais', () => {
    expect(() => parseCidr('300.1.1.1')).toThrow(/inválido/);
    expect(() => parseCidr('200.1.1.1/33')).toThrow(/Prefixo/);
    expect(() => parseCidr('0.0.0.0/0')).toThrow(/ampla/);
    expect(() => parseCidr('200.0.0.0/8')).toThrow(/ampla/);
    expect(() => parseCidr('::/0')).toThrow(/ampla/);
    expect(() => parseCidr('1::2::3')).toThrow(/inválido/);
    expect(parseAllowList('  \n# só comentário\n')).toEqual([]);
  });
});
