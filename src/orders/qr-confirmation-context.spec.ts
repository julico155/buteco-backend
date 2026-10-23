import { buildQrConfirmationContext } from './qr-confirmation-context';
import { OrderResponse } from './orders.service';

function baseOrder(overrides: Partial<OrderResponse> = {}): OrderResponse {
  return {
    id: 'order-1',
    orderNumber: 'ORD-260929-007',
    customerId: 'customer-1',
    channel: 'whatsapp',
    customerName: 'Juan Pérez',
    tableId: null,
    billRequestedAt: null,
    deliveryType: 'delivery',
    paymentMethod: 'qr',
    qrScope: null,
    paymentStatus: 'unpaid',
    status: 'confirmed',
    notes: null,
    subtotalAmount: 22,
    deliveryBaseAmount: 8,
    deliverySurchargeAmount: 2,
    totalAmount: 32,
    deliveryQuoteStatus: 'quoted',
    deliveryDistanceMeters: 4200,
    cashConfirmedAt: null,
    splitCashAmount: null,
    splitQrAmount: null,
    splitCashConfirmedAt: null,
    statusUpdatedBy: null,
    deliveryDriverName: null,
    deliveryAcceptedAt: null,
    deliveredAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    items: [
      {
        productId: 'p1',
        productCodeSnapshot: 'TRP',
        productNameSnapshot: 'Hamburguesa',
        unitPriceSnapshot: 18,
        quantity: 1,
        subtotal: 18,
        excludedComplements: [],
        roundNumber: 1,
      },
      {
        productId: 'p2',
        productCodeSnapshot: 'LIM',
        productNameSnapshot: 'Limonada',
        unitPriceSnapshot: 4,
        quantity: 1,
        subtotal: 4,
        excludedComplements: [],
        roundNumber: 1,
      },
    ],
    promotions: [],
    ...overrides,
  };
}

describe('buildQrConfirmationContext', () => {
  it('desglosa productos, subtotal, envío y monto autoritativo del QR (delivery)', () => {
    const context = buildQrConfirmationContext(baseOrder());

    expect(context).toEqual({
      orderNumber: 'ORD-260929-007',
      currency: 'BOB',
      deliveryType: 'delivery',
      items: [
        { name: 'Hamburguesa', quantity: 1, unitPrice: 18, subtotal: 18, excludedComplements: [] },
        { name: 'Limonada', quantity: 1, unitPrice: 4, subtotal: 4, excludedComplements: [] },
      ],
      promotions: [],
      subtotalAmount: 22,
      deliveryBaseAmount: 8,
      deliverySurchargeAmount: 2,
      deliveryAmount: 10,
      totalAmount: 32,
      qrAmount: 22,
      qrScope: null,
    });
  });

  it('delivery con QR de comida + envío: qrAmount es el total y qrScope viaja al agente', () => {
    const context = buildQrConfirmationContext(baseOrder({ qrScope: 'food_and_delivery' }));

    expect(context.qrAmount).toBe(32);
    expect(context.totalAmount).toBe(32);
    expect(context.qrScope).toBe('food_and_delivery');
  });

  it('delivery con QR solo comida: qrAmount es el subtotal', () => {
    const context = buildQrConfirmationContext(baseOrder({ qrScope: 'food_only' }));

    expect(context.qrAmount).toBe(22);
  });

  it('pickup/mesa: deliveryAmount queda en 0, qrAmount sigue siendo el subtotal', () => {
    const context = buildQrConfirmationContext(
      baseOrder({
        deliveryType: 'pickup',
        deliveryBaseAmount: 0,
        deliverySurchargeAmount: 0,
        totalAmount: 22,
      }),
    );

    expect(context.deliveryType).toBe('pickup');
    expect(context.deliveryAmount).toBe(0);
    expect(context.qrAmount).toBe(22);
    expect(context.totalAmount).toBe(22);
  });

  it('incluye combos con sus componentes', () => {
    const context = buildQrConfirmationContext(
      baseOrder({
        items: [],
        promotions: [
          {
            promotionId: 'promo-1',
            promotionNameSnapshot: 'Combo Hamburguesa',
            promoPriceSnapshot: 20,
            comboQuantity: 1,
            subtotal: 20,
            componentsSnapshot: [
              { productId: 'p1', code: 'TRP', name: 'Hamburguesa', unitPrice: 18, quantity: 1 },
              { productId: 'p3', code: 'GAS', name: 'Gaseosa', unitPrice: 2, quantity: 1 },
            ],
            roundNumber: 1,
          },
        ],
      }),
    );

    expect(context.promotions).toEqual([
      {
        name: 'Combo Hamburguesa',
        quantity: 1,
        unitPrice: 20,
        subtotal: 20,
        components: [
          { name: 'Hamburguesa', quantity: 1 },
          { name: 'Gaseosa', quantity: 1 },
        ],
      },
    ]);
  });
});

describe('buildQrConfirmationContext — opciones elegidas', () => {
  it('lleva las opciones CON NOMBRES (para que el cliente vea las carnes) solo en las líneas que las tienen', () => {
    const base = baseOrder();
    const context = buildQrConfirmationContext({
      ...base,
      items: [
        {
          ...base.items[0],
          productNameSnapshot: 'Tabla de Zeus',
          selectedOptions: [
            { groupId: 'g1', optionId: 'o1', groupCode: 'carne-1', groupName: 'Carne 1', optionCode: 'pollo', optionName: 'Pollo', priceDelta: 0 },
            { groupId: 'g2', optionId: 'o2', groupCode: 'carne-2', groupName: 'Carne 2', optionCode: 'costilla-res', optionName: 'Costilla de res', priceDelta: 0 },
          ],
        },
        { ...base.items[0], productNameSnapshot: 'Gaseosa' },
      ],
    });

    expect(context.items[0].selectedOptions).toEqual([
      { groupName: 'Carne 1', optionName: 'Pollo', priceDelta: 0 },
      { groupName: 'Carne 2', optionName: 'Costilla de res', priceDelta: 0 },
    ]);
    // Los ítems sin opciones no llevan la clave: el contexto de siempre no cambia.
    expect(context.items[1]).not.toHaveProperty('selectedOptions');
  });
});
