import { checkReplaceable, hasMoneySignal, isActiveOrderStatus, MoneySignalInput } from './order-replacement';

const noMoney: MoneySignalInput = { chargeStatuses: [], attemptStatuses: [], anyPaidDetectedAt: false };

describe('isActiveOrderStatus', () => {
  it('treats everything except cancelled/delivered as active', () => {
    expect(isActiveOrderStatus('draft')).toBe(true);
    expect(isActiveOrderStatus('awaiting_location')).toBe(true);
    expect(isActiveOrderStatus('confirmed')).toBe(true);
    expect(isActiveOrderStatus('preparing')).toBe(true);
    expect(isActiveOrderStatus('ready')).toBe(true);
    expect(isActiveOrderStatus('out_for_delivery')).toBe(true);
    expect(isActiveOrderStatus('cancelled')).toBe(false);
    expect(isActiveOrderStatus('delivered')).toBe(false);
  });
});

describe('hasMoneySignal', () => {
  it('is false with no charges/attempts at all (QR never generated)', () => {
    expect(hasMoneySignal(noMoney)).toBe(false);
  });

  it('is false with only a pending charge and pending_review attempt (QR generated, unpaid)', () => {
    expect(
      hasMoneySignal({ chargeStatuses: ['pending'], attemptStatuses: ['pending_review'], anyPaidDetectedAt: false }),
    ).toBe(false);
  });

  it('is false with a cancelled/expired charge (never got paid, or closed clean)', () => {
    expect(
      hasMoneySignal({ chargeStatuses: ['cancelled', 'expired'], attemptStatuses: ['rejected'], anyPaidDetectedAt: false }),
    ).toBe(false);
  });

  it('is true when a charge is confirmed', () => {
    expect(hasMoneySignal({ ...noMoney, chargeStatuses: ['confirmed'] })).toBe(true);
  });

  it('is true when a charge is paid_unapplied (bank charged, could not apply)', () => {
    expect(hasMoneySignal({ ...noMoney, chargeStatuses: ['paid_unapplied'] })).toBe(true);
  });

  it('is true when a payment_attempt was accepted', () => {
    expect(hasMoneySignal({ ...noMoney, attemptStatuses: ['accepted'] })).toBe(true);
  });

  it('is true when paid_detected_at is set, even if the charge status has not caught up yet', () => {
    expect(hasMoneySignal({ ...noMoney, anyPaidDetectedAt: true })).toBe(true);
  });
});

describe('checkReplaceable', () => {
  it('allows a fresh awaiting_location order with no money signal', () => {
    expect(checkReplaceable({ status: 'awaiting_location', paymentStatus: 'unpaid' }, noMoney)).toEqual({ ok: true });
  });

  it('allows a confirmed order with a QR generated but unpaid (pending_review is not money)', () => {
    const money: MoneySignalInput = { chargeStatuses: ['pending'], attemptStatuses: ['pending_review'], anyPaidDetectedAt: false };
    expect(checkReplaceable({ status: 'confirmed', paymentStatus: 'unpaid' }, money)).toEqual({ ok: true });
  });

  it('blocks when payment_status is paid, regardless of status', () => {
    expect(checkReplaceable({ status: 'confirmed', paymentStatus: 'paid' }, noMoney)).toEqual({
      ok: false,
      reasonCode: 'already_paid',
    });
  });

  it('blocks a rejected payment_status (pago rechazado), not just paid', () => {
    expect(checkReplaceable({ status: 'confirmed', paymentStatus: 'rejected' }, noMoney)).toEqual({
      ok: false,
      reasonCode: 'payment_status_not_unpaid',
    });
  });

  it('blocks an orders.payment_status of pending_review (distinto de payment_attempts.review_status)', () => {
    expect(checkReplaceable({ status: 'confirmed', paymentStatus: 'pending_review' }, noMoney)).toEqual({
      ok: false,
      reasonCode: 'payment_status_not_unpaid',
    });
  });

  it('blocks on any money signal even if payment_status is still unpaid (paid_unapplied)', () => {
    const money: MoneySignalInput = { chargeStatuses: ['paid_unapplied'], attemptStatuses: [], anyPaidDetectedAt: true };
    expect(checkReplaceable({ status: 'confirmed', paymentStatus: 'unpaid' }, money)).toEqual({
      ok: false,
      reasonCode: 'payment_in_progress',
    });
  });

  it('blocks an order already in the operational flow (preparing/ready/out_for_delivery)', () => {
    expect(checkReplaceable({ status: 'preparing', paymentStatus: 'paid' }, noMoney)).toEqual({
      ok: false,
      reasonCode: 'already_paid',
    });
    // Estado inesperado (no debería pasar: preparing exige paid) — igual cae fail-closed, nunca 'ok'.
    expect(checkReplaceable({ status: 'ready', paymentStatus: 'unpaid' }, noMoney)).toEqual({
      ok: false,
      reasonCode: 'operational',
    });
  });

  it('blocks draft (no debería llegar acá vía activeOrder, pero fail-closed si pasa)', () => {
    expect(checkReplaceable({ status: 'draft', paymentStatus: 'unpaid' }, noMoney)).toEqual({
      ok: false,
      reasonCode: 'operational',
    });
  });
});
