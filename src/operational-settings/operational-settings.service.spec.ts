import { DomainException, ValidationError } from '../common/exceptions/domain-exception';
import { OperationalSettingsService } from './operational-settings.service';
import { ALL_AVAILABLE } from './availability.fixtures';

const CURRENT_ROW = {
  id: true,
  rain_surcharge_enabled: false,
  rain_surcharge_amount: '0',
  business_opens_hour: 17,
  business_closes_hour: 22,
  restaurant_latitude: null,
  restaurant_longitude: null,
  min_order_delivery: '0.00',
  min_order_pickup: '0.00',
  min_order_dine_in: '0.00',
  delivery_pricing_mode: 'bands' as 'bands' | 'fixed' | 'free',
  delivery_fixed_fee: null as string | null,
  delivery_free_over_amount: null as string | null,
  delivery_max_distance_meters: null as number | null,
  manual_quote_max_amount: '500.00',
  cash_prepayment_required: false,
  updated_at: new Date(),
  ...ALL_AVAILABLE,
};

const PAYMENT_ALL = [
  { service_type: 'delivery', enabled: true },
  { service_type: 'pickup', enabled: true },
  { service_type: 'dine_in', enabled: true },
];

function build(
  opts: { current?: typeof CURRENT_ROW; payment?: { service_type: string; enabled: boolean }[] } = {},
) {
  const current = opts.current ?? CURRENT_ROW;
  const sets: Record<string, unknown>[] = [];
  const tables: string[] = [];
  const db = {
    selectFrom: jest.fn((table: string) => {
      tables.push(table);
      if (table === 'payment_options') {
        return { select: () => ({ execute: async () => opts.payment ?? PAYMENT_ALL }) };
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: Record<string, any> = {
        selectAll: () => chain,
        where: () => chain,
        executeTakeFirstOrThrow: async () => current,
      };
      return chain;
    }),
    updateTable: jest.fn(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: Record<string, any> = {
        set: (values: Record<string, unknown>) => {
          sets.push(values);
          return chain;
        },
        where: () => chain,
        returningAll: () => chain,
        executeTakeFirstOrThrow: async () => ({ ...current, ...sets[0] }),
      };
      return chain;
    }),
  };
  return { service: new OperationalSettingsService(db as never), sets, tables };
}

describe('OperationalSettingsService.update — servicios y canales', () => {
  it('apagar un servicio escribe la columna y lo refleja en la respuesta', async () => {
    const { service, sets } = build();
    const response = await service.update({ serviceDineInEnabled: false });

    expect(sets[0]).toMatchObject({ service_dine_in_enabled: false });
    expect(response.serviceDineInEnabled).toBe(false);
    expect(response.serviceDeliveryEnabled).toBe(true);
  });

  it('rechaza apagar el último servicio habilitado sin escribir nada', async () => {
    const only = { ...CURRENT_ROW, service_delivery_enabled: false, service_pickup_enabled: false };
    const { service, sets } = build({ current: only });

    await expect(service.update({ serviceDineInEnabled: false })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(sets).toHaveLength(0);
  });

  it('rechaza apagar el último canal habilitado', async () => {
    const only = { ...CURRENT_ROW, channel_pos_enabled: false, channel_whatsapp_enabled: false };
    const { service } = build({ current: only });

    await expect(service.update({ channelWebEnabled: false })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rechaza prender un servicio que no tiene forma de pago habilitada', async () => {
    const off = { ...CURRENT_ROW, service_delivery_enabled: false };
    const payment = PAYMENT_ALL.map((o) =>
      o.service_type === 'delivery' ? { ...o, enabled: false } : o,
    );
    const { service, sets } = build({ current: off, payment });

    const error = await service.update({ serviceDeliveryEnabled: true }).catch((e) => e);

    expect(error).toBeInstanceOf(DomainException);
    expect((error as DomainException).code).toBe('no_payment_option_enabled');
    expect(sets).toHaveLength(0);
  });

  it('un cambio que no toca servicios ni canales no consulta payment_options', async () => {
    const { service, tables } = build();
    await service.update({ rainSurchargeEnabled: true });

    expect(tables).not.toContain('payment_options');
  });
});

describe('OperationalSettingsService.update — pedido mínimo y tarifa de envío', () => {
  it('guarda los mínimos con 2 decimales y los devuelve como número', async () => {
    const { service, sets } = build();
    const response = await service.update({ minOrderDelivery: 35, minOrderDineIn: 12.5 });

    expect(sets[0]).toMatchObject({ min_order_delivery: '35.00', min_order_dine_in: '12.50' });
    expect(response.minOrderDelivery).toBe(35);
    expect(response.minOrderDineIn).toBe(12.5);
  });

  it('guarda cashPrepaymentRequired y lo devuelve', async () => {
    const { service, sets } = build();
    const response = await service.update({ cashPrepaymentRequired: true });

    expect(sets[0]).toMatchObject({ cash_prepayment_required: true });
    expect(response.cashPrepaymentRequired).toBe(true);
  });

  it('guarda el tope de cotización manual con 2 decimales y lo devuelve como número', async () => {
    const { service, sets } = build();
    const response = await service.update({ manualQuoteMaxAmount: 750 });

    expect(sets[0]).toMatchObject({ manual_quote_max_amount: '750.00' });
    expect(response.manualQuoteMaxAmount).toBe(750);
  });

  it('modo fixed sin monto fijo se rechaza sin escribir', async () => {
    const { service, sets } = build();
    await expect(service.update({ deliveryPricingMode: 'fixed' })).rejects.toBeInstanceOf(ValidationError);
    expect(sets).toHaveLength(0);
  });

  it('modo fixed con el monto en el mismo PATCH se acepta', async () => {
    const { service, sets } = build();
    const response = await service.update({ deliveryPricingMode: 'fixed', deliveryFixedFee: 8 });

    expect(sets[0]).toMatchObject({ delivery_pricing_mode: 'fixed', delivery_fixed_fee: '8.00' });
    expect(response.deliveryFixedFee).toBe(8);
  });

  it('no deja borrar el monto fijo mientras el modo sigue siendo fixed', async () => {
    const fixed = { ...CURRENT_ROW, delivery_pricing_mode: 'fixed' as const, delivery_fixed_fee: '8.00' };
    const { service } = build({ current: fixed });
    await expect(service.update({ deliveryFixedFee: null })).rejects.toBeInstanceOf(ValidationError);
  });

  it('null desactiva el envío gratis sobre un monto y el techo', async () => {
    const withLimits = {
      ...CURRENT_ROW,
      delivery_free_over_amount: '60.00',
      delivery_max_distance_meters: 8000,
    };
    const { service, sets } = build({ current: withLimits });
    await service.update({ deliveryFreeOverAmount: null, deliveryMaxDistanceMeters: null });

    expect(sets[0]).toMatchObject({ delivery_free_over_amount: null, delivery_max_distance_meters: null });
  });
});
