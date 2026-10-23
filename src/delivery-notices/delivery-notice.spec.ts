import {
  buildDeliveryNotice,
  mapsLink,
  mergeNoticeItems,
  noticeItemName,
  prepTimeLine,
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
    expect(text).toContain('  2 x Pizza');
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

describe('delivery notice — personas y tiempo de preparación', () => {
  it('nombra la línea con las personas: serves_label de la tabla o el tamaño elegido; nunca las carnes', () => {
    expect(noticeItemName('Tabla de Zeus', '2 a 3 personas', [{ optionName: 'Pollo', showInNotice: false }])).toBe(
      'Tabla de Zeus (2 a 3 personas)',
    );
    expect(noticeItemName('Tablita de pollo', null, [{ optionName: '1 persona', showInNotice: true }])).toBe(
      'Tablita de pollo (1 persona)',
    );
    expect(noticeItemName('Pizza', null, [])).toBe('Pizza');
    expect(noticeItemName('Pizza', '  ', undefined)).toBe('Pizza');
  });

  it('juntar por nombre es seguro: la misma tabla con otras carnes suma, y distinto tamaño NO se mezcla', () => {
    const items = mergeNoticeItems([
      { name: noticeItemName('Tabla de Zeus', '2 a 3 personas', []), quantity: 1 },
      { name: noticeItemName('Tabla de Zeus', '2 a 3 personas', []), quantity: 1 },
      { name: noticeItemName('Tablita de pollo', null, [{ optionName: '1 persona', showInNotice: true }]), quantity: 1 },
      { name: noticeItemName('Tablita de pollo', null, [{ optionName: '2 personas', showInNotice: true }]), quantity: 1 },
    ]);
    expect(items).toEqual([
      { name: 'Tabla de Zeus (2 a 3 personas)', quantity: 2 },
      { name: 'Tablita de pollo (1 persona)', quantity: 1 },
      { name: 'Tablita de pollo (2 personas)', quantity: 1 },
    ]);
  });

  it('imprime «N x nombre» y, AL FINAL de todo, el tiempo de preparación', () => {
    const text = buildDeliveryNotice({
      ...base,
      items: [
        { name: 'Tabla de Zeus (2 a 3 personas)', quantity: 2 },
        { name: 'Tablita de pollo (1 persona)', quantity: 1 },
      ],
      prepMinutes: 40,
    });

    expect(text).toContain('  2 x Tabla de Zeus (2 a 3 personas)');
    expect(text).toContain('  1 x Tablita de pollo (1 persona)');
    expect(text.split('\n').at(-1)).toBe('Tiempo de preparación: ~40 min');
    expect(text.indexOf('Ubicación:')).toBeLessThan(text.indexOf('Tiempo de preparación'));
  });

  it('sin tiempo en ningún producto no se imprime la línea', () => {
    expect(buildDeliveryNotice({ ...base, prepMinutes: null })).not.toContain('Tiempo de preparación');
    expect(buildDeliveryNotice(base)).not.toContain('Tiempo de preparación');
    expect(prepTimeLine(0)).toBeNull();
    expect(prepTimeLine(25)).toBe('Tiempo de preparación: ~25 min');
  });
});
