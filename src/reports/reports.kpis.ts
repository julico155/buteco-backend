export interface KpiGroupRow {
  channel: string;
  payment_method: string;
  delivery_type: string;
  payment_status: string;
  status: string;
  orders: number;
  total: number;
}

export interface BreakdownEntry {
  key: string;
  orders: number;
  salesAmount: number;
}

export interface KpisResult {
  /** Todos los pedidos creados en el rango (cualquier estado). */
  totalOrders: number;
  /** Vendido = pagado y no cancelado. */
  sold: { orders: number; salesAmount: number; averageTicket: number };
  cancelled: { orders: number; rate: number };
  /** No cancelados y todavía sin pagar. */
  unpaid: { orders: number; amount: number };
  byChannel: BreakdownEntry[];
  byPaymentMethod: BreakdownEntry[];
  byDeliveryType: BreakdownEntry[];
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function isSold(row: KpiGroupRow): boolean {
  return row.payment_status === 'paid' && row.status !== 'cancelled';
}

function breakdown(rows: KpiGroupRow[], keyOf: (row: KpiGroupRow) => string): BreakdownEntry[] {
  const map = new Map<string, BreakdownEntry>();
  for (const row of rows) {
    const key = keyOf(row);
    const entry = map.get(key) ?? { key, orders: 0, salesAmount: 0 };
    entry.orders += row.orders;
    entry.salesAmount += row.total;
    map.set(key, entry);
  }
  return [...map.values()]
    .map((e) => ({ ...e, salesAmount: round2(e.salesAmount) }))
    .sort((a, b) => b.salesAmount - a.salesAmount);
}

export function computeKpis(rows: KpiGroupRow[]): KpisResult {
  const soldRows = rows.filter(isSold);
  const cancelledRows = rows.filter((r) => r.status === 'cancelled');
  const unpaidRows = rows.filter((r) => r.status !== 'cancelled' && r.payment_status !== 'paid');

  const sum = (list: KpiGroupRow[], field: 'orders' | 'total') =>
    list.reduce((acc, r) => acc + r[field], 0);

  const totalOrders = sum(rows, 'orders');
  const soldOrders = sum(soldRows, 'orders');
  const salesAmount = sum(soldRows, 'total');
  const cancelledOrders = sum(cancelledRows, 'orders');

  return {
    totalOrders,
    sold: {
      orders: soldOrders,
      salesAmount: round2(salesAmount),
      averageTicket: soldOrders > 0 ? round2(salesAmount / soldOrders) : 0,
    },
    cancelled: {
      orders: cancelledOrders,
      rate: totalOrders > 0 ? round2(cancelledOrders / totalOrders) : 0,
    },
    unpaid: { orders: sum(unpaidRows, 'orders'), amount: round2(sum(unpaidRows, 'total')) },
    byChannel: breakdown(soldRows, (r) => r.channel),
    byPaymentMethod: breakdown(soldRows, (r) => r.payment_method),
    byDeliveryType: breakdown(soldRows, (r) => r.delivery_type),
  };
}
