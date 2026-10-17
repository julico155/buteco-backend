import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateOrderReplacementDto } from '../../order-replacement/dto/create-order-replacement.dto';
import { CreateOrderDto } from './create-order.dto';

/**
 * NO se ha ejecutado todavía. Reproduce el ValidationPipe global de `main.ts` (`whitelist`, `transform`,
 * `forbidNonWhitelisted`): así se prueba el contrato HTTP del cuerpo sin levantar el servidor.
 */
const PIPE = { whitelist: true, forbidNonWhitelisted: true } as const;

const baseOrder = {
  customerName: 'Ana',
  deliveryType: 'delivery',
  paymentMethod: 'cash',
  items: [{ productId: '11111111-1111-4111-8111-111111111111', quantity: 1 }],
};

async function errorsOf<T extends object>(cls: new () => T, body: unknown): Promise<string[]> {
  const instance = plainToInstance(cls, body);
  const errors = await validate(instance, PIPE);
  const flat = (list: typeof errors, prefix = ''): string[] =>
    list.flatMap((error) => [
      ...(error.constraints ? [`${prefix}${error.property}`] : []),
      ...flat(error.children ?? [], `${prefix}${error.property}.`),
    ]);
  return flat(errors);
}

describe('CreateOrderDto.deliveryLocation', () => {
  it('un cuerpo anterior, sin ubicación, sigue siendo válido', async () => {
    expect(await errorsOf(CreateOrderDto, baseOrder)).toEqual([]);
  });

  it('con ubicación numérica válida es válido', async () => {
    expect(await errorsOf(CreateOrderDto, { ...baseOrder, deliveryLocation: { latitude: -17.78, longitude: -63.18 } })).toEqual([]);
  });

  it.each([
    ['latitud como texto', { latitude: '-17.78', longitude: -63.18 }],
    ['longitud como texto', { latitude: -17.78, longitude: '-63.18' }],
    ['latitud fuera de rango', { latitude: 91, longitude: 0 }],
    ['longitud fuera de rango', { latitude: 0, longitude: -181 }],
    ['sin longitud', { latitude: 0 }],
    ['sin latitud', { longitude: 0 }],
    ['vacía', {}],
    ['latitud NaN', { latitude: Number.NaN, longitude: 0 }],
    ['longitud infinita', { latitude: 0, longitude: Number.POSITIVE_INFINITY }],
  ])('ubicación inválida (%s) se rechaza', async (_name, deliveryLocation) => {
    expect((await errorsOf(CreateOrderDto, { ...baseOrder, deliveryLocation })).length).toBeGreaterThan(0);
  });

  it('un importe de delivery (u otro campo) dentro de la ubicación se rechaza: nunca se confía en montos del navegador', async () => {
    for (const extra of [{ deliveryAmount: 0 }, { feeAmount: 5 }, { surchargeAmount: 0 }, { totalAmount: 1 }, { quoteId: 'x' }, { freeShipping: true }]) {
      const errors = await errorsOf(CreateOrderDto, { ...baseOrder, deliveryLocation: { latitude: 1, longitude: 1, ...extra } });

      expect(errors.length).toBeGreaterThan(0);
    }
  });

  it('un importe de delivery suelto en el pedido tampoco se acepta', async () => {
    expect((await errorsOf(CreateOrderDto, { ...baseOrder, deliveryAmount: 0 })).length).toBeGreaterThan(0);
    expect((await errorsOf(CreateOrderDto, { ...baseOrder, subtotalAmount: 999 })).length).toBeGreaterThan(0);
  });
});

describe('CreateOrderReplacementDto.deliveryLocation', () => {
  const baseReplacement = {
    customerPhone: '+59170001234',
    orderId: '22222222-2222-4222-8222-222222222222',
    customerName: 'Ana',
    deliveryType: 'delivery',
    paymentMethod: 'cash',
    items: [],
  };

  it('es opcional y, si viene, numérica y en rango', async () => {
    expect(await errorsOf(CreateOrderReplacementDto, baseReplacement)).toEqual([]);
    expect(await errorsOf(CreateOrderReplacementDto, { ...baseReplacement, deliveryLocation: { latitude: -17.78, longitude: -63.18 } })).toEqual([]);
    expect((await errorsOf(CreateOrderReplacementDto, { ...baseReplacement, deliveryLocation: { latitude: 'x', longitude: 0 } })).length).toBeGreaterThan(0);
    expect((await errorsOf(CreateOrderReplacementDto, { ...baseReplacement, deliveryLocation: { latitude: 0, longitude: 0, amount: 1 } })).length).toBeGreaterThan(0);
  });
});
