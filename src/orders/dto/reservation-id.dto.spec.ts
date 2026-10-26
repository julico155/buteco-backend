import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateOrderDto } from './create-order.dto';

/** Mismo ValidationPipe global que `main.ts`: `reservationId` tiene que pasar `forbidNonWhitelisted`. */
const PIPE = { whitelist: true, forbidNonWhitelisted: true } as const;

const baseOrder = {
  customerName: 'Mesa 4',
  deliveryType: 'dine_in',
  paymentMethod: 'qr',
  items: [{ productId: '11111111-1111-4111-8111-111111111111', quantity: 2 }],
};

const errorsOf = async (body: unknown) => (await validate(plainToInstance(CreateOrderDto, body), PIPE)).map((e) => e.property);

describe('CreateOrderDto.reservationId', () => {
  it('es opcional: un pedido de mesa sin reserva es válido', async () => {
    expect(await errorsOf(baseOrder)).toEqual([]);
  });

  it('acepta un UUID', async () => {
    expect(await errorsOf({ ...baseOrder, reservationId: '33333333-3333-4333-8333-333333333333' })).toEqual([]);
  });

  it.each([['no-es-uuid'], [123], [''], ['33333333']])('rechaza %j', async (reservationId) => {
    expect(await errorsOf({ ...baseOrder, reservationId })).toContain('reservationId');
  });

  it('un campo cualquiera sigue rechazado (forbidNonWhitelisted)', async () => {
    expect(await errorsOf({ ...baseOrder, tableId: 'x' })).toContain('tableId');
  });
});
