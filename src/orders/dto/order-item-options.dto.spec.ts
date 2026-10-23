import { ValidationPipe } from '@nestjs/common';
import { hashRequestBody } from '../../common/idempotency/idempotency.service';
import { idempotencyBody } from '../delivery-location';
import { CreateOrderDto } from './create-order.dto';

// El mismo pipe global de main.ts: un campo no declarado en el DTO es 400.
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
const transform = (body: unknown) => pipe.transform(body, { type: 'body', metatype: CreateOrderDto });

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_G = '22222222-2222-4222-8222-222222222222';
const UUID_O = '33333333-3333-4333-8333-333333333333';

const legacyBody = {
  customerName: 'Ana',
  deliveryType: 'pickup',
  paymentMethod: 'cash',
  items: [{ productId: UUID_A, quantity: 2, excludedComplements: ['cebolla'] }],
};

describe('CreateOrderDto — items[].selectedOptions', () => {
  it('un cuerpo anterior (sin selectedOptions) sigue siendo válido y su hash no cambia', async () => {
    const dto = (await transform(legacyBody)) as CreateOrderDto;
    expect(dto.items[0].selectedOptions).toBeUndefined();

    // La huella que calculaba el despliegue anterior: el DTO de entonces no tenía la clave `selectedOptions`.
    const without = (source: object, omit: string) => Object.fromEntries(Object.entries(source).filter(([key]) => key !== omit));
    const before = { ...without(dto, 'deliveryLocation'), items: dto.items.map((item) => without(item, 'selectedOptions')) };

    expect(hashRequestBody(idempotencyBody(dto))).toBe(hashRequestBody(before));
    expect(JSON.stringify(idempotencyBody(dto))).not.toContain('selectedOptions');
  });

  it('acepta una selección de ids y la conserva', async () => {
    const dto = (await transform({
      ...legacyBody,
      items: [{ productId: UUID_A, quantity: 1, selectedOptions: [{ groupId: UUID_G, optionId: UUID_O }] }],
    })) as CreateOrderDto;

    expect(dto.items[0].selectedOptions).toEqual([{ groupId: UUID_G, optionId: UUID_O }]);
    expect(JSON.stringify(idempotencyBody(dto))).toContain(UUID_O);
  });

  it('rechaza con 400 un campo extra dentro de una opción (p. ej. un precio del cliente)', async () => {
    await expect(
      transform({ ...legacyBody, items: [{ productId: UUID_A, quantity: 1, selectedOptions: [{ groupId: UUID_G, optionId: UUID_O, priceDelta: 0 }] }] }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rechaza ids que no son UUID y listas demasiado largas', async () => {
    await expect(
      transform({ ...legacyBody, items: [{ productId: UUID_A, quantity: 1, selectedOptions: [{ groupId: 'x', optionId: UUID_O }] }] }),
    ).rejects.toMatchObject({ status: 400 });

    const tooMany = Array.from({ length: 21 }, () => ({ groupId: UUID_G, optionId: UUID_O }));
    await expect(
      transform({ ...legacyBody, items: [{ productId: UUID_A, quantity: 1, selectedOptions: tooMany }] }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
