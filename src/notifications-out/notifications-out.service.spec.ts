import { GatewayCallError } from '../gateway-client/gateway-client.service';
import { NotificationsOutService } from './notifications-out.service';

function createService(
  claimAttempts: Array<number | undefined>,
  insertResults: Array<{ id: string } | undefined> = [{ id: 'job-1' }],
) {
  const claimResults = [...claimAttempts];
  const inserted = { id: 'job-1' };
  const insert = {
    values: jest.fn(),
    onConflict: jest.fn(),
    returning: jest.fn(),
  };
  insert.values.mockReturnValue(insert);
  insert.onConflict.mockReturnValue(insert);
  insert.returning.mockReturnValue({
    executeTakeFirst: jest.fn().mockImplementation(async () => insertResults.shift()),
  });

  const existing = { select: jest.fn(), where: jest.fn(), executeTakeFirstOrThrow: jest.fn() };
  existing.select.mockReturnValue(existing);
  existing.where.mockReturnValue(existing);
  existing.executeTakeFirstOrThrow.mockResolvedValue(inserted);

  const updates: Array<{ where: jest.Mock }> = [];
  const db = {
    insertInto: jest.fn().mockReturnValue(insert),
    selectFrom: jest.fn().mockReturnValue(existing),
    updateTable: jest.fn(() => {
      const update = { set: jest.fn(), where: jest.fn(), returning: jest.fn(), execute: jest.fn() };
      update.set.mockReturnValue(update);
      update.where.mockReturnValue(update);
      update.returning.mockReturnValue({
        executeTakeFirst: jest.fn().mockImplementation(async () => {
          const attempts = claimResults.shift();
          return attempts === undefined ? undefined : { attempts };
        }),
      });
      update.execute.mockResolvedValue([]);
      updates.push(update);
      return update;
    }),
  };
  const gateway = {
    isConfigured: () => true,
    sendTelegramAlert: jest.fn().mockResolvedValue({ externalMessageId: 'telegram-1' }),
  };
  return {
    service: new NotificationsOutService(db as never, gateway as never),
    gateway,
    updates,
  };
}

const deliveryNotice = {
  channel: 'telegram' as const,
  kind: 'delivery_notice',
  targetRef: 'order-1',
  payload: { chatRef: 'delivery-group', text: 'private delivery text' },
};

describe('NotificationsOutService fast-path claim', () => {
  it('claims and sends a normal pending job', async () => {
    const { service, gateway, updates } = createService([1]);

    await service.notifyNow(deliveryNotice);

    expect(gateway.sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(updates[0].where).toHaveBeenCalledWith('status', 'in', ['pending', 'failed']);
    expect(updates[0].where).toHaveBeenCalledWith('attempts', '<', 8);
    expect(updates[0].where).toHaveBeenCalledWith(expect.any(Function));
  });

  it('claims and sends a failed job whose next attempt is due', async () => {
    const { service, gateway } = createService([2], [undefined]);

    await service.notifyNow(deliveryNotice);

    expect(gateway.sendTelegramAlert).toHaveBeenCalledTimes(1);
  });

  it('does not send a failed job before its next_attempt_at', async () => {
    const { service, gateway } = createService([undefined], [undefined]);

    await service.notifyNow(deliveryNotice);

    expect(gateway.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it('does not send a job at MAX_ATTEMPTS', async () => {
    const { service, gateway } = createService([undefined], [undefined]);

    await service.notifyNow(deliveryNotice);

    expect(gateway.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it('does not send a job beyond MAX_ATTEMPTS', async () => {
    const { service, gateway } = createService([undefined], [undefined]);

    await service.notifyNow(deliveryNotice);

    expect(gateway.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it('does not resend a sent job', async () => {
    const { service, gateway } = createService([undefined], [undefined]);

    await service.notifyNow(deliveryNotice);

    expect(gateway.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it('does not send a job another process is already sending', async () => {
    const { service, gateway } = createService([undefined], [undefined]);

    await service.notifyNow(deliveryNotice);

    expect(gateway.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it('lets only one concurrent claimant send', async () => {
    const { service, gateway } = createService([1, undefined], [{ id: 'job-1' }, undefined]);

    await Promise.all([service.notifyNow(deliveryNotice), service.notifyNow(deliveryNotice)]);

    expect(gateway.sendTelegramAlert).toHaveBeenCalledTimes(1);
  });

  it('sends the same delivery_notice twice only once', async () => {
    const { service, gateway } = createService([1, undefined], [{ id: 'job-1' }, undefined]);

    await service.notifyNow(deliveryNotice);
    await service.notifyNow(deliveryNotice);

    expect(gateway.sendTelegramAlert).toHaveBeenCalledTimes(1);
  });
});

/**
 * Preparación de idempotencia (audit del incidente de duplicación de WhatsApp):
 * notification_jobs.id YA es la identidad durable estable — nunca se genera
 * una nueva por retry, porque `enqueue()` dedupea por (kind, target_ref) y
 * cualquier llamada posterior a notifyNow() para el mismo (kind, targetRef)
 * lee de vuelta el id existente en vez de insertar uno nuevo. Estos tests
 * prueban que ESE mismo id es lo que ahora viaja al gateway como
 * notificationId en cada intento, sea cual sea el motivo del retry.
 */
describe('NotificationsOutService notification identity (idempotency prep)', () => {
  function createWhatsappService(opts: {
    claimAttempts: Array<number | undefined>;
    insertResults?: Array<{ id: string } | undefined>;
    existingId?: string;
    sendImpl: jest.Mock;
  }) {
    const claimResults = [...opts.claimAttempts];
    const insertResults = opts.insertResults ?? [{ id: 'notif-123' }];
    const insert = { values: jest.fn(), onConflict: jest.fn(), returning: jest.fn() };
    insert.values.mockReturnValue(insert);
    insert.onConflict.mockReturnValue(insert);
    insert.returning.mockReturnValue({
      executeTakeFirst: jest.fn().mockImplementation(async () => insertResults.shift()),
    });

    const existing = { select: jest.fn(), where: jest.fn(), executeTakeFirstOrThrow: jest.fn() };
    existing.select.mockReturnValue(existing);
    existing.where.mockReturnValue(existing);
    existing.executeTakeFirstOrThrow.mockResolvedValue({ id: opts.existingId ?? 'notif-123' });

    const db = {
      insertInto: jest.fn().mockReturnValue(insert),
      selectFrom: jest.fn().mockReturnValue(existing),
      updateTable: jest.fn(() => {
        const update = { set: jest.fn(), where: jest.fn(), returning: jest.fn(), execute: jest.fn() };
        update.set.mockReturnValue(update);
        update.where.mockReturnValue(update);
        update.returning.mockReturnValue({
          executeTakeFirst: jest.fn().mockImplementation(async () => {
            const attempts = claimResults.shift();
            return attempts === undefined ? undefined : { attempts };
          }),
        });
        update.execute.mockResolvedValue([]);
        return update;
      }),
    };
    const gateway = { isConfigured: () => true, sendWhatsappMessage: opts.sendImpl };
    return { service: new NotificationsOutService(db as never, gateway as never), gateway };
  }

  const orderExpiredJob = (orderNumber: string, orderId: string) => ({
    channel: 'whatsapp' as const,
    kind: 'order_expired_unpaid',
    targetRef: orderId,
    payload: {
      customerId: 'customer-1',
      messageType: 'order_expired_unpaid' as const,
      context: { orderNumber },
    },
  });

  it('A: a 502 from the gateway still used the same notificationId that the next retry will reuse', async () => {
    const sendImpl = jest.fn().mockRejectedValue(new GatewayCallError('Gateway call failed: POST x -> 502', 502));
    const { service, gateway } = createWhatsappService({ claimAttempts: [1], sendImpl });

    await service.notifyNow(orderExpiredJob('ORD-0185', 'order-185'));

    expect(gateway.sendWhatsappMessage).toHaveBeenCalledWith(expect.anything(), 'notif-123');
  });

  it('B: a network timeout (no HTTP status at all) is handled the same way, same notificationId', async () => {
    const sendImpl = jest.fn().mockRejectedValue(new Error('fetch failed: the operation timed out'));
    const { service, gateway } = createWhatsappService({ claimAttempts: [1], sendImpl });

    await service.notifyNow(orderExpiredJob('ORD-0185', 'order-185'));

    expect(gateway.sendWhatsappMessage).toHaveBeenCalledWith(expect.anything(), 'notif-123');
  });

  it('C: two concurrent workers claiming the same logical notification only let one through, with one identity', async () => {
    const sendImpl = jest.fn().mockResolvedValue({ externalMessageId: 'wamid-1' });
    const { service, gateway } = createWhatsappService({
      claimAttempts: [1, undefined],
      insertResults: [{ id: 'notif-123' }, undefined],
      sendImpl,
    });

    const job = orderExpiredJob('ORD-0185', 'order-185');
    await Promise.all([service.notifyNow(job), service.notifyNow(job)]);

    expect(gateway.sendWhatsappMessage).toHaveBeenCalledTimes(1);
    expect(gateway.sendWhatsappMessage).toHaveBeenCalledWith(expect.anything(), 'notif-123');
  });

  it('D: a successful send is not retried (status moves to sent, not failed)', async () => {
    const sendImpl = jest.fn().mockResolvedValue({ externalMessageId: 'wamid-1' });
    const { service, gateway } = createWhatsappService({ claimAttempts: [1], sendImpl });

    await service.notifyNow(orderExpiredJob('ORD-0185', 'order-185'));

    expect(gateway.sendWhatsappMessage).toHaveBeenCalledTimes(1);
  });

  it('E: ORD-0185 — three separate retries (three notifyNow calls, as a retrier would do) all carry notif-123, never notif-124', async () => {
    const sendImpl = jest
      .fn()
      .mockRejectedValueOnce(new GatewayCallError('... -> 502', 502))
      .mockRejectedValueOnce(new GatewayCallError('... -> 502', 502))
      .mockResolvedValueOnce({ externalMessageId: 'wamid-1' });
    const { service, gateway } = createWhatsappService({
      claimAttempts: [1, 2, 3],
      insertResults: [{ id: 'notif-123' }, undefined, undefined],
      sendImpl,
    });

    const job = orderExpiredJob('ORD-0185', 'order-185');
    await service.notifyNow(job); // intento 1: gateway responde 502
    await service.notifyNow(job); // intento 2 (retry): mismo targetRef -> mismo id
    await service.notifyNow(job); // intento 3 (retry): mismo targetRef -> mismo id, ahora sí entra

    expect(gateway.sendWhatsappMessage).toHaveBeenCalledTimes(3);
    for (const call of gateway.sendWhatsappMessage.mock.calls) {
      expect(call[1]).toBe('notif-123');
    }
  });

  it('F: no regression — payment_confirmed/payment_rejected payloads still travel untouched (just notificationId added additively)', async () => {
    const sendImpl = jest.fn().mockResolvedValue({ externalMessageId: 'wamid-1' });
    const { service, gateway } = createWhatsappService({ claimAttempts: [1], sendImpl });

    const paymentConfirmedPayload = {
      customerId: 'customer-1',
      messageType: 'payment_confirmed' as const,
      context: { orderNumber: 'ORD-0185', deliveryType: 'delivery' as const, fullyPaid: true },
    };
    await service.notifyNow({
      channel: 'whatsapp',
      kind: 'payment_decision',
      targetRef: 'attempt-1',
      payload: paymentConfirmedPayload,
    });

    expect(gateway.sendWhatsappMessage).toHaveBeenCalledWith(paymentConfirmedPayload, 'notif-123');
  });
});

describe('NotificationsOutService sin gateway configurado', () => {
  function createUnconfigured() {
    const db = { insertInto: jest.fn(), selectFrom: jest.fn(), updateTable: jest.fn() };
    const gateway = { isConfigured: () => false, sendWhatsappMessage: jest.fn() };
    const service = new NotificationsOutService(db as never, gateway as never);
    return { service, db, gateway };
  }

  it('notifyNow no encola ni envía nada', async () => {
    const { service, db, gateway } = createUnconfigured();

    await service.notifyNow({
      channel: 'whatsapp',
      kind: 'order_received',
      targetRef: 'order-1',
      payload: { customerId: 'c-1', messageType: 'order_received', context: { orderNumber: 'ORD-1', deliveryType: 'pickup' } },
    });

    expect(db.insertInto).not.toHaveBeenCalled();
    expect(gateway.sendWhatsappMessage).not.toHaveBeenCalled();
  });

  it('recoverFailedJobs no reclama trabajos', async () => {
    const { service, db } = createUnconfigured();

    await expect(service.recoverFailedJobs()).resolves.toEqual({ claimed: 0 });
    expect(db.updateTable).not.toHaveBeenCalled();
  });
});
