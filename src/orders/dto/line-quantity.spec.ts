import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OrderItemInputDto } from './order-item-input.dto';
import { OrderPromotionInputDto } from './order-promotion-input.dto';

const UUID = '3f2b7c1e-8a4d-4f6b-9c2e-1a5d7e9b0c34';

async function quantityErrors(dto: object): Promise<string[]> {
  const errors = await validate(dto);
  return errors.filter((e) => e.property === 'quantity').map((e) => e.property);
}

describe('máximo de unidades por línea del carrito', () => {
  it('productos: acepta hasta 30 y rechaza 31', async () => {
    const ok = plainToInstance(OrderItemInputDto, { productId: UUID, quantity: 30 });
    const tooMany = plainToInstance(OrderItemInputDto, { productId: UUID, quantity: 31 });

    expect(await quantityErrors(ok)).toEqual([]);
    expect(await quantityErrors(tooMany)).toEqual(['quantity']);
  });

  it('promociones: acepta hasta 30 y rechaza 31', async () => {
    const ok = plainToInstance(OrderPromotionInputDto, { promotionId: UUID, quantity: 30, revision: 1 });
    const tooMany = plainToInstance(OrderPromotionInputDto, { promotionId: UUID, quantity: 31, revision: 1 });

    expect(await quantityErrors(ok)).toEqual([]);
    expect(await quantityErrors(tooMany)).toEqual(['quantity']);
  });

  it('sigue rechazando 0 y fracciones', async () => {
    const zero = plainToInstance(OrderItemInputDto, { productId: UUID, quantity: 0 });
    const fraction = plainToInstance(OrderItemInputDto, { productId: UUID, quantity: 1.5 });

    expect(await quantityErrors(zero)).toEqual(['quantity']);
    expect(await quantityErrors(fraction)).toEqual(['quantity']);
  });
});
