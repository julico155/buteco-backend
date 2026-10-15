import { deriveTableState } from './table-state';

describe('deriveTableState', () => {
  it('sin cuenta y activa está libre', () => {
    expect(deriveTableState({ isActive: true, account: null })).toBe('free');
  });

  it('sin cuenta e inactiva está fuera de servicio', () => {
    expect(deriveTableState({ isActive: false, account: null })).toBe('out_of_service');
  });

  it('con cuenta abierta está ocupada', () => {
    expect(
      deriveTableState({ isActive: true, account: { status: 'open', billRequestedAt: null } }),
    ).toBe('occupied');
  });

  it('con "pidió la cuenta" está por cobrar', () => {
    expect(
      deriveTableState({
        isActive: true,
        account: { status: 'open', billRequestedAt: new Date() },
      }),
    ).toBe('bill_requested');
  });

  it('con la cuenta cerrada y el cobro pendiente sigue por cobrar', () => {
    expect(
      deriveTableState({ isActive: true, account: { status: 'confirmed', billRequestedAt: null } }),
    ).toBe('bill_requested');
  });

  it('una cuenta viva gana sobre una mesa desactivada', () => {
    expect(
      deriveTableState({ isActive: false, account: { status: 'open', billRequestedAt: null } }),
    ).toBe('occupied');
  });
});
