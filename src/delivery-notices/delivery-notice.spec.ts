import {
  buildDeliveryNotice,
  mapsLink,
  mergeNoticeItems,
  whatsappLink,
} from './delivery-notice';

const base = {
  orderNumber: 'ORD-0007',
  customerName: 'Juan Pérez',
  customerPhone: '+591 7000-0000',
  items: [
    { name: 'Pizza', quantity: 2 },
    { name: 'Hamburguesa', quantity: 1 },
  ],
  deliveryAmount: 13,
  subtotalAmount: 42,
  isCash: false,
  deliveryFeePaid: false as boolean | null,
  customerNote: 'Sin cebolla',
  latitude: -17.78,
  longitude: -63.18,
  distanceMeters: 4800,
};

describe('delivery notice', () => {
  it('merges loose products and promotion components by name', () => {
    expect(
      mergeNoticeItems([
        { name: 'Pizza', quantity: 1 },
        { name: 'Hamburguesa', quantity: 1 },
        { name: 'Pizza', quantity: 2 },
      ]),
    ).toEqual([
      { name: 'Pizza', quantity: 3 },
      { name: 'Hamburguesa', quantity: 1 },
    ]);
  });

  it('renders the operational QR delivery text in plain text', () => {
    const text = buildDeliveryNotice(base);

    expect(text).toContain('ORD-0007');
    expect(text).toContain('Teléfono: https://wa.me/59170000000');
    expect(text).toContain('Pedido (3 productos):');
    expect(text).toContain('  2x Pizza');
    expect(text).toContain('Envío: Bs 13 · 4.8 km');
    expect(text).toContain('COBRAR ENVÍO');
    expect(text).toContain('NOTA DEL CLIENTE:\nSin cebolla');
    expect(text).toContain('Ubicación: https://www.google.com/maps/search/?api=1&query=-17.78,-63.18');
    expect(text).not.toContain('<b>');
  });

  it('creates usable WhatsApp and Google Maps links', () => {
    expect(whatsappLink('+591 7568-1881')).toBe('https://wa.me/59175681881');
    expect(mapsLink(-17.78, -63.18)).toBe(
      'https://www.google.com/maps/search/?api=1&query=-17.78,-63.18',
    );
  });

  it('distinguishes paid and payable delivery fees', () => {
    expect(buildDeliveryNotice({ ...base, deliveryFeePaid: true })).toContain('ENVÍO PAGADO');
    expect(buildDeliveryNotice({ ...base, deliveryFeePaid: true })).not.toContain('COBRAR ENVÍO');
    expect(buildDeliveryNotice({ ...base, deliveryFeePaid: null })).toContain('COBRAR ENVÍO');
  });

  it('uses the cash collection layout without HTML', () => {
    const text = buildDeliveryNotice({ ...base, isCash: true });

    expect(text).toContain('PEDIDO EN EFECTIVO');
    expect(text).toContain('Productos: Bs 42');
    expect(text).toContain('TOTAL A COBRAR: Bs 55');
    expect(text).not.toContain('COBRAR ENVÍO');
    expect(text).not.toContain('<b>');
  });
});
