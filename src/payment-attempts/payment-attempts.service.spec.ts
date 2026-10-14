import { PaymentAttemptsService } from './payment-attempts.service';

type Scenario = {
  decision: 'accepted' | 'rejected';
  casWinner?: boolean;
  paymentMethod?: 'qr' | 'split';
  splitCashConfirmed?: boolean;
  deliveryRejects?: boolean;
  deliveryType?: 'delivery' | 'pickup' | 'dine_in';
  /** Simula que un replacement (FASE 3) ganó la carrera: el UPDATE final (WHERE status != 'cancelled') no afecta filas. */
  orderAlreadyCancelled?: boolean;
};

function createService(scenario: Scenario) {
  const attempt = {
    id: 'attempt-1',
    order_id: 'order-1',
    customer_id: 'customer-1',
    opened_at: new Date('2026-09-29T00:00:00.000Z'),
    opened_as: 'normal',
    review_status: 'pending_review',
    reviewed_at: null,
  };
  const currentOrder = {
    register_session_id: null,
    payment_method: scenario.paymentMethod ?? 'qr',
    split_cash_confirmed_at: scenario.splitCashConfirmed ? new Date() : null,
    delivery_type: scenario.deliveryType ?? 'delivery',
    order_number: 'ORD-260929-007',
  };

  const attemptsUpdate = {
    set: jest.fn(),
    where: jest.fn(),
    returningAll: jest.fn(),
  };
  attemptsUpdate.set.mockReturnValue(attemptsUpdate);
  attemptsUpdate.where.mockReturnValue(attemptsUpdate);
  attemptsUpdate.returningAll.mockReturnValue({
    executeTakeFirst: jest.fn().mockResolvedValue(scenario.casWinner === false ? undefined : attempt),
  });

  const orderUpdate = { set: jest.fn(), where: jest.fn(), returning: jest.fn() };
  orderUpdate.set.mockReturnValue(orderUpdate);
  orderUpdate.where.mockReturnValue(orderUpdate);
  orderUpdate.returning.mockReturnValue({
    executeTakeFirstOrThrow: jest.fn().mockResolvedValue({ customer_id: 'customer-1' }),
    executeTakeFirst: jest.fn().mockResolvedValue(
      scenario.orderAlreadyCancelled === true ? undefined : { customer_id: 'customer-1' },
    ),
  });

  const orderSelect = { select: jest.fn(), where: jest.fn(), executeTakeFirstOrThrow: jest.fn() };
  orderSelect.select.mockReturnValue(orderSelect);
  orderSelect.where.mockReturnValue(orderSelect);
  orderSelect.executeTakeFirstOrThrow.mockResolvedValue(currentOrder);

  const replaySelect = { selectAll: jest.fn(), where: jest.fn(), executeTakeFirst: jest.fn() };
  replaySelect.selectAll.mockReturnValue(replaySelect);
  replaySelect.where.mockReturnValue(replaySelect);
  replaySelect.executeTakeFirst.mockResolvedValue({ ...attempt, review_status: scenario.decision });

  const trx = {
    updateTable: jest.fn((table: string) => (table === 'payment_attempts' ? attemptsUpdate : orderUpdate)),
    selectFrom: jest.fn((table: string) => (table === 'payment_attempts' ? replaySelect : orderSelect)),
  };
  const db = { transaction: () => ({ execute: async (fn: (value: typeof trx) => unknown) => fn(trx) }) };
  const notifications = { notifyNow: jest.fn().mockResolvedValue(undefined) };
  const cashRegister = { sessionIdForPayment: jest.fn().mockResolvedValue('register-1') };
  const deliveryNotices = {
    notifyConfirmed: scenario.deliveryRejects
      ? jest.fn().mockRejectedValue(new Error('telegram unavailable'))
      : jest.fn().mockResolvedValue(undefined),
  };
  return {
    service: new PaymentAttemptsService(db as never, notifications as never, cashRegister as never, deliveryNotices as never),
    deliveryNotices,
    notifications,
  };
}

describe('PaymentAttemptsService delivery notice trigger', () => {
  it('notifies delivery only after an accepted QR decision makes the order paid', async () => {
    const { service, deliveryNotices } = createService({ decision: 'accepted' });

    await service.decide('attempt-1', 'accepted');
    await flushNotifications();

    expect(deliveryNotices.notifyConfirmed).toHaveBeenCalledWith('order-1');
  });

  it('does not notify for a rejected decision', async () => {
    const { service, deliveryNotices } = createService({ decision: 'rejected' });

    await service.decide('attempt-1', 'rejected');
    await flushNotifications();

    expect(deliveryNotices.notifyConfirmed).not.toHaveBeenCalled();
  });

  it('does not notify when the payment-attempt CAS replay loses', async () => {
    const { service, deliveryNotices } = createService({ decision: 'accepted', casWinner: false });

    await service.decide('attempt-1', 'accepted');
    await flushNotifications();

    expect(deliveryNotices.notifyConfirmed).not.toHaveBeenCalled();
  });

  it('does not notify after only the QR leg of an unpaid split', async () => {
    const { service, deliveryNotices } = createService({
      decision: 'accepted',
      paymentMethod: 'split',
      splitCashConfirmed: false,
    });

    await service.decide('attempt-1', 'accepted');
    await flushNotifications();

    expect(deliveryNotices.notifyConfirmed).not.toHaveBeenCalled();
  });

  it('notifies once when an accepted QR leg completes a split', async () => {
    const { service, deliveryNotices } = createService({
      decision: 'accepted',
      paymentMethod: 'split',
      splitCashConfirmed: true,
    });

    await service.decide('attempt-1', 'accepted');
    await flushNotifications();

    expect(deliveryNotices.notifyConfirmed).toHaveBeenCalledTimes(1);
    expect(deliveryNotices.notifyConfirmed).toHaveBeenCalledWith('order-1');
  });

  it('keeps an accepted payment decision successful when Telegram notification fails', async () => {
    const { service } = createService({ decision: 'accepted', deliveryRejects: true });

    await expect(service.decide('attempt-1', 'accepted')).resolves.toMatchObject({ won: true });
    await flushNotifications();
  });

  it('returns the accepted decision without waiting for a slow notification gateway', async () => {
    const { service } = createService({ decision: 'accepted' });
    const notifications = (service as unknown as { notifications: { notifyNow: jest.Mock } }).notifications;
    notifications.notifyNow.mockImplementation(() => new Promise<void>(() => undefined));

    await expect(
      Promise.race([
        service.decide('attempt-1', 'accepted'),
        new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 25)),
      ]),
    ).resolves.not.toBe('timed_out');
  });
});

describe('PaymentAttemptsService payment_decision copy', () => {
  it('sends a structured payment_confirmed intent (fullyPaid: true) when the order becomes fully paid', async () => {
    const { service, notifications } = createService({ decision: 'accepted', deliveryType: 'delivery' });

    await service.decide('attempt-1', 'accepted');
    await flushNotifications();

    expect(notifications.notifyNow).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'payment_decision',
        payload: {
          customerId: 'customer-1',
          messageType: 'payment_confirmed',
          context: { orderNumber: 'ORD-260929-007', deliveryType: 'delivery', fullyPaid: true },
        },
      }),
    );
  });

  it('propagates the order deliveryType (pickup) untouched', async () => {
    const { service, notifications } = createService({ decision: 'accepted', deliveryType: 'pickup' });

    await service.decide('attempt-1', 'accepted');
    await flushNotifications();

    expect(notifications.notifyNow).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ context: expect.objectContaining({ deliveryType: 'pickup' }) }),
      }),
    );
  });

  it('sends payment_confirmed with fullyPaid: false for an accepted QR leg that leaves a split still unpaid', async () => {
    const { service, notifications } = createService({
      decision: 'accepted',
      paymentMethod: 'split',
      splitCashConfirmed: false,
    });

    await service.decide('attempt-1', 'accepted');
    await flushNotifications();

    expect(notifications.notifyNow).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          customerId: 'customer-1',
          messageType: 'payment_confirmed',
          context: { orderNumber: 'ORD-260929-007', deliveryType: 'delivery', fullyPaid: false },
        },
      }),
    );
    expect(notifications.notifyNow).not.toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ text: expect.anything() }) }),
    );
  });

  it('sends a structured payment_rejected intent', async () => {
    const { service, notifications } = createService({ decision: 'rejected' });

    await service.decide('attempt-1', 'rejected');
    await flushNotifications();

    expect(notifications.notifyNow).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          customerId: 'customer-1',
          messageType: 'payment_rejected',
          context: { orderNumber: 'ORD-260929-007', deliveryType: 'delivery' },
        },
      }),
    );
  });
});

describe('PaymentAttemptsService vs a cancelled/replaced order', () => {
  it('never applies a late payment to an order that a replacement (or anything else) already cancelled', async () => {
    const { service } = createService({ decision: 'accepted', orderAlreadyCancelled: true });

    await expect(service.decide('attempt-1', 'accepted')).rejects.toMatchObject({
      code: 'order_not_payable',
    });
  });
});

async function flushNotifications(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
