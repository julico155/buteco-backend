import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { agentBillingConfig, commissionFor, paysAgentCommission } from './agent-billing';

const configWith = (value: unknown) => ({ get: () => value }) as unknown as ConfigService<AppConfig, true>;
const full = { commissionPercent: 3, overdraftLimit: 10, lowBalanceThreshold: 10, topupMinAmount: 10 };

describe('commissionFor', () => {
  it.each([
    [60, 3, 1.8],
    [100, 3, 3],
    [45.5, 3, 1.37], // 1.365 -> mitad hacia arriba
    [0.01, 3, 0],
    [10, 5.5, 0.55],
    [19.99, 7, 1.4], // 1.3993
    [1234.56, 2.5, 30.86], // 30.864
  ])('%d Bs al %d %% -> %d', (subtotal, percent, expected) => {
    expect(commissionFor(subtotal, percent)).toBe(expected);
  });

  it('no arrastra decimales de punto flotante', () => {
    // 0.1 + 0.2 = 0.30000000000000004: la cuenta va en centavos.
    expect(commissionFor(0.1 + 0.2, 10)).toBe(0.03);
    expect(String(commissionFor(33.33, 3))).not.toMatch(/\.\d{3,}/);
  });
});

describe('paysAgentCommission', () => {
  it('solo el agente (whatsapp) por QR paga comisión', () => {
    expect(paysAgentCommission('whatsapp', 'qr')).toBe(true);
    expect(paysAgentCommission('whatsapp', 'cash')).toBe(false);
    expect(paysAgentCommission('pos', 'qr')).toBe(false);
    expect(paysAgentCommission('web', 'qr')).toBe(false);
    expect(paysAgentCommission('external', 'qr')).toBe(false);
  });
});

describe('agentBillingConfig', () => {
  it('con porcentaje mayor a 0 devuelve la configuración', () => {
    expect(agentBillingConfig(configWith(full))).toEqual(full);
  });

  it('con 0 %, la comisión está apagada', () => {
    expect(agentBillingConfig(configWith({ ...full, commissionPercent: 0 }))).toBeNull();
  });

  it.each([[undefined], [null], [20], [[]], ['x'], [{}], [{ commissionPercent: 'abc' }], [{ commissionPercent: -1 }]])(
    'ante una forma inesperada (%j) queda apagada, nunca rompe',
    (value) => {
      expect(agentBillingConfig(configWith(value))).toBeNull();
    },
  );

  it('completa con valores por defecto lo que falte', () => {
    expect(agentBillingConfig(configWith({ commissionPercent: 5 }))).toEqual({
      commissionPercent: 5,
      overdraftLimit: 10,
      lowBalanceThreshold: 10,
      topupMinAmount: 10,
    });
  });
});
