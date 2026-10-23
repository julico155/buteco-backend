export interface DeliveryNoticeItem {
  /** Ya con las personas / el tamaño (ver `noticeItemName`): es también la clave con la que se juntan las líneas. */
  name: string;
  quantity: number;
}

/**
 * Nombre de la línea para el repartidor: «Tabla de Zeus (2 a 3 personas)», «Tablita de pollo (1 persona)». Las personas salen de
 * `serves_label` del producto o de lo elegido en un grupo marcado `showInNotice` (el «Tamaño»). Las carnes elegidas NO se
 * nombran: el repartidor no las necesita, y por eso dos tablas iguales con otras carnes se juntan en una sola línea.
 */
export function noticeItemName(
  productName: string,
  servesLabel: string | null | undefined,
  selectedOptions: ReadonlyArray<{ optionName: string; showInNotice: boolean }> | undefined,
): string {
  const parts: string[] = [];
  const serves = servesLabel?.trim();
  if (serves) parts.push(serves);
  for (const option of selectedOptions ?? []) {
    if (option.showInNotice) parts.push(option.optionName);
  }
  return parts.length === 0 ? productName : `${productName} (${parts.join(', ')})`;
}

/** «Tiempo de preparación: ~40 min». Sin tiempo en ningún producto del pedido, no se imprime. */
export function prepTimeLine(prepMinutes: number | null | undefined): string | null {
  return typeof prepMinutes === 'number' && prepMinutes > 0 ? `Tiempo de preparación: ~${prepMinutes} min` : null;
}

export interface DeliveryNoticeInput {
  orderNumber: string;
  customerName: string | null;
  customerPhone: string;
  items: DeliveryNoticeItem[];
  deliveryAmount: number;
  subtotalAmount: number;
  isCash: boolean;
  deliveryFeePaid: boolean | null;
  customerNote: string | null;
  latitude: number;
  longitude: number;
  distanceMeters: number | null;
  /** Máximo de `prep_minutes` de los productos del pedido (se cocinan en paralelo); null si ninguno lo declara. */
  prepMinutes?: number | null;
}

/** Conserva el orden de la primera aparición y suma productos de combos y líneas sueltas. */
export function mergeNoticeItems(items: DeliveryNoticeItem[]): DeliveryNoticeItem[] {
  const byName = new Map<string, DeliveryNoticeItem>();
  for (const item of items) {
    const previous = byName.get(item.name);
    if (previous) previous.quantity += item.quantity;
    else byName.set(item.name, { ...item });
  }
  return [...byName.values()];
}

export function whatsappLink(phone: string): string {
  const digits = phone.replace(/\D+/g, '');
  return digits === '' ? phone : `https://wa.me/${digits}`;
}

export function mapsLink(latitude: number, longitude: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
}

export function shortOrderNumber(orderNumber: string): string {
  const match = /^ORD-\d{6}-(\d+)$/.exec(orderNumber.trim());
  return match === null ? orderNumber : `ORD-${match[1]}`;
}

export function buildDeliveryNotice(input: DeliveryNoticeInput): string {
  const lines: string[] = [shortOrderNumber(input.orderNumber), ''];
  const customerName = input.customerName?.trim() || 'sin nombre';
  lines.push(`Cliente: ${customerName}`);
  lines.push(`Teléfono: ${whatsappLink(input.customerPhone)}`);
  lines.push('');

  const itemCount = input.items.reduce((total, item) => total + item.quantity, 0);
  lines.push(`Pedido (${itemCount} ${itemCount === 1 ? 'producto' : 'productos'}):`);
  for (const item of input.items) lines.push(`  ${item.quantity} x ${item.name}`);
  lines.push('');

  const distance = input.distanceMeters === null ? '' : ` · ${(input.distanceMeters / 1000).toFixed(1)} km`;
  if (input.isCash) {
    lines.push('PEDIDO EN EFECTIVO');
    lines.push(`Productos: Bs ${formatBs(input.subtotalAmount)}`);
    lines.push(`Envío: Bs ${formatBs(input.deliveryAmount)}${distance}`);
    lines.push(`TOTAL A COBRAR: Bs ${formatBs(input.subtotalAmount + input.deliveryAmount)}`);
    lines.push('');
  } else {
    lines.push(`Envío: Bs ${formatBs(input.deliveryAmount)}${distance}`);
    lines.push('');
    lines.push(input.deliveryFeePaid === true ? 'ENVÍO PAGADO' : 'COBRAR ENVÍO');
    lines.push('');
  }

  const noteLines = (input.customerNote ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (noteLines.length > 0) {
    lines.push('NOTA DEL CLIENTE:', ...noteLines, '');
  }

  lines.push(`Ubicación: ${mapsLink(input.latitude, input.longitude)}`);
  // Al final de todo el desglose.
  const prep = prepTimeLine(input.prepMinutes);
  if (prep !== null) lines.push(prep);
  return lines.join('\n');
}

function formatBs(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}
