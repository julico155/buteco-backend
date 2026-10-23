import {
  InvalidOptionSelectionError,
  OptionUnavailableError,
} from '../common/exceptions/domain-exception';
import { localWeekdayAndMinute } from '../common/time/weekly-schedule';
import { OrderItemSelectedOption } from '../database/types';

import { OrderItemSelectedOptionResponse } from './dto/order-response.dto';
export { OrderItemSelectedOptionResponse };

/** Lo que manda el cliente por opción elegida: solo ids, nunca precios. */
export interface SelectedOptionInput {
  groupId: string;
  optionId: string;
}

/** Sin `showInNotice` (bandera interna del aviso de delivery). */
export function toSelectedOptionResponse(option: OrderItemSelectedOption): OrderItemSelectedOptionResponse {
  return {
    groupId: option.groupId,
    optionId: option.optionId,
    groupCode: option.groupCode,
    groupName: option.groupName,
    optionCode: option.optionCode,
    optionName: option.optionName,
    priceDelta: option.priceDelta,
  };
}

export interface OptionGroupRow {
  id: string;
  product_id: string;
  code: string;
  name: string;
  min_select: number;
  max_select: number;
  show_in_notice: boolean;
}

export interface OptionRow {
  id: string;
  group_id: string;
  code: string;
  name: string;
  price_delta: string;
  is_available: boolean;
}

/** Clave orden-insensible de la selección de una línea (dos líneas con la misma tabla y otras carnes son líneas distintas). */
export function selectionKey(selected: SelectedOptionInput[] | undefined): string {
  return JSON.stringify((selected ?? []).map((s) => `${s.groupId}:${s.optionId}`).sort());
}

/** Clave orden-insensible de los complementos excluidos de una línea. */
export function complementsKey(excluded: string[] | undefined): string {
  return JSON.stringify([...(excluded ?? [])].sort());
}

/**
 * Identidad de una línea de pedido: mismo producto + mismos complementos excluidos + misma selección de opciones. Dos líneas
 * con la misma identidad deberían ser una sola con más `quantity`.
 */
export function itemLineKey(item: {
  productId: string;
  excludedComplements?: string[];
  selectedOptions?: SelectedOptionInput[];
}): string {
  return `${item.productId}::${complementsKey(item.excludedComplements)}::${selectionKey(item.selectedOptions)}`;
}

/**
 * Valida la selección de UNA línea contra los grupos/opciones de su producto y devuelve el snapshot a guardar más la suma de
 * los `price_delta`. Todo sale de la base: el cliente solo manda ids.
 *
 * - cada grupo elegido pertenece al producto y cada opción pertenece a su grupo;
 * - la misma opción no se repite dentro de un MISMO grupo (en grupos distintos sí: «pollo» en Carne 1 y en Carne 2);
 * - la cantidad elegida por grupo cumple `min_select` / `max_select` (también para los grupos que no se tocaron);
 * - una opción agotada se rechaza con `option_unavailable`.
 */
export function resolveSelectedOptions(params: {
  productId: string;
  selected: SelectedOptionInput[] | undefined;
  groups: OptionGroupRow[];
  options: OptionRow[];
}): { selectedOptions: OrderItemSelectedOption[]; priceDelta: number } {
  const { productId } = params;
  const selected = params.selected ?? [];
  const groups = params.groups.filter((g) => g.product_id === productId);
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const optionById = new Map(params.options.map((o) => [o.id, o]));

  const countByGroup = new Map<string, number>();
  const seen = new Set<string>();
  const resolved: OrderItemSelectedOption[] = [];
  const unavailableOptionIds: string[] = [];
  let firstUnavailable: { groupId: string; optionId: string } | null = null;
  let priceDelta = 0;

  for (const choice of selected) {
    const group = groupById.get(choice.groupId);
    if (!group) {
      throw new InvalidOptionSelectionError('unknown_group', { productId, groupId: choice.groupId });
    }
    const option = optionById.get(choice.optionId);
    if (!option || option.group_id !== group.id) {
      throw new InvalidOptionSelectionError('unknown_option', {
        productId,
        groupId: choice.groupId,
        optionId: choice.optionId,
      });
    }
    const pair = `${group.id}:${option.id}`;
    if (seen.has(pair)) {
      throw new InvalidOptionSelectionError('duplicate_option', {
        productId,
        groupId: group.id,
        optionId: option.id,
      });
    }
    seen.add(pair);
    countByGroup.set(group.id, (countByGroup.get(group.id) ?? 0) + 1);

    if (!option.is_available) {
      unavailableOptionIds.push(option.id);
      firstUnavailable ??= { groupId: group.id, optionId: option.id };
    }
    const delta = Number(option.price_delta);
    priceDelta += delta;
    resolved.push({
      groupId: group.id,
      optionId: option.id,
      groupCode: group.code,
      groupName: group.name,
      optionCode: option.code,
      optionName: option.name,
      priceDelta: delta,
      showInNotice: group.show_in_notice,
    });
  }

  for (const group of groups) {
    const count = countByGroup.get(group.id) ?? 0;
    if (count < group.min_select || count > group.max_select) {
      throw new InvalidOptionSelectionError(count < group.min_select ? 'too_few' : 'too_many', {
        productId,
        groupId: group.id,
        minSelect: group.min_select,
        maxSelect: group.max_select,
      });
    }
  }

  if (firstUnavailable) {
    throw new OptionUnavailableError({ productId, ...firstUnavailable, unavailableOptionIds });
  }

  // Siempre en el orden de los grupos del catálogo, no en el que mandó el cliente: la comanda y el snapshot salen estables.
  const groupOrder = new Map(groups.map((g, index) => [g.id, index]));
  resolved.sort((a, b) => (groupOrder.get(a.groupId) ?? 0) - (groupOrder.get(b.groupId) ?? 0));
  return { selectedOptions: resolved, priceDelta: roundMoney(priceDelta) };
}

/**
 * ¿Se vende el producto en el día calendario (America/La_Paz) del instante dado? `weekdays` = domingo 0 … sábado 6; null = todos
 * los días. ÚNICO lugar donde se decide la disponibilidad por día: si el negocio pasa a «día de negocio», se cambia aquí.
 */
export function isAvailableOnDay(weekdays: number[] | null | undefined, instant: Date): boolean {
  if (weekdays === null || weekdays === undefined) return true;
  const local = localWeekdayAndMinute(instant);
  // Un instante ilegible no vende un producto restringido: ante la duda se rechaza.
  return local !== null && weekdays.includes(local.weekday);
}

export function roundMoney(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/** Tiempo de preparación del pedido: el MÁXIMO de las líneas (la cocina las prepara en paralelo), null si ninguna lo declara. */
export function maxPrepMinutes(values: Array<number | null | undefined>): number | null {
  const present = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  return present.length === 0 ? null : Math.max(...present);
}
