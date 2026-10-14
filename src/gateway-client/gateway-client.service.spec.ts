import { Logger } from '@nestjs/common';
import { GatewayClientService } from './gateway-client.service';

describe('GatewayClientService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('logs only technical failure metadata', async () => {
    const config = {
      get: jest.fn().mockReturnValue({ baseUrl: 'https://gateway.example', authToken: 'token-for-test' }),
    };
    const service = new GatewayClientService(config as never);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const sensitiveResponse = 'phone=59170000000 token=provider-secret';
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      headers: new Headers({ 'x-request-id': 'request-123' }),
      text: jest.fn().mockResolvedValue(sensitiveResponse),
    }) as never;

    await expect(service.requestWhatsappLocation({ customerId: 'customer-id' })).rejects.toThrow(
      'Gateway call failed: POST /gateway/whatsapp/location-requests -> 502',
    );

    expect(warn).toHaveBeenCalledWith(
      'Gateway call failed: POST /gateway/whatsapp/location-requests -> 502 requestId=request-123',
    );
    expect(String(warn.mock.calls[0][0])).not.toContain(sensitiveResponse);
  });

  it('carries notificationId as both the Idempotency-Key header and a body field when given', async () => {
    const config = {
      get: jest.fn().mockReturnValue({ baseUrl: 'https://gateway.example', authToken: 'token-for-test' }),
    };
    const service = new GatewayClientService(config as never);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: jest.fn().mockResolvedValue({ externalMessageId: 'wamid-1' }),
    }) as never;

    await service.sendWhatsappMessage(
      { customerId: 'customer-1', messageType: 'order_received', context: { orderNumber: 'ORD-0185', deliveryType: 'pickup' } },
      'notif-123',
    );

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(init.headers['Idempotency-Key']).toBe('notif-123');
    const sentBody = JSON.parse(init.body);
    expect(sentBody.notificationId).toBe('notif-123');
    expect(sentBody.context).toEqual({ orderNumber: 'ORD-0185', deliveryType: 'pickup' });
  });

  it('stays byte-for-byte backward compatible when notificationId is omitted (no header, no new field)', async () => {
    const config = {
      get: jest.fn().mockReturnValue({ baseUrl: 'https://gateway.example', authToken: 'token-for-test' }),
    };
    const service = new GatewayClientService(config as never);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: jest.fn().mockResolvedValue({ externalMessageId: 'wamid-1' }),
    }) as never;

    const payload = { customerId: 'customer-1', messageType: 'order_received' as const, context: { orderNumber: 'ORD-0185', deliveryType: 'pickup' as const } };
    await service.sendWhatsappMessage(payload);

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(init.headers).not.toHaveProperty('Idempotency-Key');
    expect(JSON.parse(init.body)).toEqual(payload);
  });
});
