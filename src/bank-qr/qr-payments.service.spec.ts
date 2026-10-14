import { DomainException } from '../common/exceptions/domain-exception';
import { QrPaymentsService } from './qr-payments.service';

/** Query builder falso: cualquier método de encadenado se devuelve a sí mismo; los terminales resuelven `result`. */
function chain(result: unknown) {
  const obj: Record<string, jest.Mock> = {};
  for (const method of ['select', 'selectAll', 'where', 'orderBy', 'limit', 'innerJoin', 'set', 'returning']) {
    obj[method] = jest.fn(() => obj);
  }
  obj.execute = jest.fn().mockResolvedValue(Array.isArray(result) ? result : []);
  obj.executeTakeFirst = jest.fn().mockResolvedValue(result);
  obj.executeTakeFirstOrThrow = jest.fn().mockResolvedValue(result);
  return obj;
}

function tableRouter(byTable: Record<string, ReturnType<typeof chain>>) {
  return jest.fn((table: string) => byTable[table] ?? chain(undefined));
}

const pendingCharge = {
  id: 'charge-1',
  order_id: 'order-1',
  payment_attempt_id: 'attempt-1',
  amount: '42.00',
  paid_detected_at: null,
  due_date: '2026-09-30',
  review_status: 'pending_review',
};

function createService(opts: {
  chargeChain: ReturnType<typeof chain>;
  bankQrChargesUpdate: ReturnType<typeof chain>;
  decide: jest.Mock;
}) {
  const db = {
    selectFrom: tableRouter({
      bank_qr_charges: opts.chargeChain,
      orders: chain({ order_number: 'ORD-0001', customer_name: 'Juan' }),
    }),
    updateTable: jest.fn((table: string) => (table === 'bank_qr_charges' ? opts.bankQrChargesUpdate : chain(undefined))),
  };
  const baneco = { statusQR: jest.fn().mockResolvedValue({ statusQrCode: 1, raw: {} }) };
  const paymentAttempts = { decide: opts.decide };
  const notifications = { notifyNow: jest.fn().mockResolvedValue(undefined) };
  const config = { get: jest.fn() };

  const service = new QrPaymentsService(db as never, baneco as never, paymentAttempts as never, notifications as never, config as never);
  return { service, db, notifications };
}

describe('QrPaymentsService.resolveCharge vs a payment_attempt that cannot apply anymore', () => {
  it('escalates straight to paid_unapplied (no grace-period retry) when the order was already cancelled/replaced', async () => {
    const bankQrChargesUpdate = chain({ id: 'charge-1' }); // CAS succeeds
    const decide = jest.fn().mockRejectedValue(
      new DomainException('order_not_payable', 409, 'El pedido ya fue cancelado.'),
    );
    const { service, db, notifications } = createService({
      chargeChain: chain(pendingCharge),
      bankQrChargesUpdate,
      decide,
    });

    await service.resolveCharge('qr-1');

    expect(decide).toHaveBeenCalledWith('attempt-1', 'accepted');
    // Va directo a paid_unapplied, no queda 'pending' esperando un reintento del cron.
    expect(db.updateTable).toHaveBeenCalledWith('bank_qr_charges');
    expect(bankQrChargesUpdate.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'paid_unapplied' }),
    );
    // El banco reportó el pago justo ahora (pendingCharge.paid_detected_at es null) —
    // el escalamiento directo debe setearlo, nunca dejarlo null.
    const setCall = bankQrChargesUpdate.set.mock.calls[0][0] as { paid_detected_at?: Date };
    expect(setCall.paid_detected_at).toBeInstanceOf(Date);
    expect(notifications.notifyNow).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'qr_paid_unapplied_alert' }),
    );
  });

  it('never overwrites an existing paid_detected_at when escalating (order_not_payable after a prior grace-period tick)', async () => {
    const existingDetectedAt = new Date('2026-09-29T12:00:00.000Z');
    const bankQrChargesUpdate = chain({ id: 'charge-1' });
    const decide = jest.fn().mockRejectedValue(
      new DomainException('order_not_payable', 409, 'El pedido ya fue cancelado.'),
    );
    const { service } = createService({
      chargeChain: chain({ ...pendingCharge, paid_detected_at: existingDetectedAt }),
      bankQrChargesUpdate,
      decide,
    });

    await service.resolveCharge('qr-1');

    const setCall = bankQrChargesUpdate.set.mock.calls[0][0] as { paid_detected_at?: Date };
    expect(setCall.paid_detected_at).toEqual(existingDetectedAt);
  });

  it('still uses the cash_register_closed grace-period path for that specific failure (unchanged)', async () => {
    const bankQrChargesUpdate = chain(undefined); // no CAS update expected on the retry_later branch
    const decide = jest.fn().mockRejectedValue(
      new DomainException('cash_register_closed', 409, 'La caja está cerrada.'),
    );
    const { service, notifications } = createService({
      chargeChain: chain(pendingCharge),
      bankQrChargesUpdate,
      decide,
    });

    await service.resolveCharge('qr-1');

    // Primer tick: dentro del margen de gracia, no escala todavía.
    expect(notifications.notifyNow).not.toHaveBeenCalled();
  });
});
