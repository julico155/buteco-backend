import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Invariante 8 del plan: los errores de dominio siempre viajan como
 * código + detalle estructurado, nunca como texto crudo de Postgres.
 */
export class DomainException extends HttpException {
  constructor(
    public readonly code: string,
    status: HttpStatus,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super({ code, message, details }, status);
  }
}

export class ValidationError extends DomainException {
  constructor(message: string, details?: Record<string, unknown>) {
    super('validation_error', HttpStatus.BAD_REQUEST, message, details);
  }
}

export class ProductUnavailableError extends DomainException {
  /**
   * `not_available_today`: el producto solo se vende ciertos días de la semana; `extra.availableWeekdays` (0 = domingo)
   * los lista para que el cliente pueda decir «solo sábados y domingos».
   */
  constructor(
    productId: string,
    reason: 'inactive' | 'sold_out' | 'not_available_today',
    unavailableProductIds?: string[],
    extra: { availableWeekdays?: number[] } = {},
  ) {
    super(
      'product_unavailable',
      HttpStatus.CONFLICT,
      `El producto ${productId} no está disponible (${reason}).`,
      { productId, reason, unavailableProductIds: unavailableProductIds ?? [productId], ...extra },
    );
  }
}

export type InvalidOptionSelectionReason =
  | 'unknown_group'
  | 'unknown_option'
  | 'duplicate_option'
  | 'too_few'
  | 'too_many';

/** La selección de opciones de una línea no es válida para ese producto (error del cliente, no se reintenta igual). */
export class InvalidOptionSelectionError extends DomainException {
  constructor(
    reason: InvalidOptionSelectionReason,
    details: { productId: string; groupId?: string; optionId?: string; minSelect?: number; maxSelect?: number },
  ) {
    super(
      'invalid_option_selection',
      HttpStatus.BAD_REQUEST,
      `La selección de opciones del producto ${details.productId} no es válida (${reason}).`,
      { reason, ...details },
    );
  }
}

/** Una opción elegida está agotada (p. ej. se acabó una carne): el cliente tiene que elegir otra. */
export class OptionUnavailableError extends DomainException {
  constructor(details: { productId: string; groupId: string; optionId: string; unavailableOptionIds: string[] }) {
    super(
      'option_unavailable',
      HttpStatus.CONFLICT,
      `La opción ${details.optionId} del producto ${details.productId} no está disponible.`,
      details,
    );
  }
}

export class PromotionUnavailableError extends DomainException {
  constructor(promotionId: string, reason: string, unavailablePromotionIds?: string[]) {
    super(
      'promotion_unavailable',
      HttpStatus.CONFLICT,
      `La promoción ${promotionId} no está disponible (${reason}).`,
      { promotionId, reason, unavailablePromotionIds: unavailablePromotionIds ?? [promotionId] },
    );
  }
}

export class IdempotencyKeyReusedError extends DomainException {
  constructor(idempotencyKey: string) {
    super(
      'idempotency_key_reused',
      HttpStatus.CONFLICT,
      `La Idempotency-Key ${idempotencyKey} ya se usó con un cuerpo de request distinto.`,
      { idempotencyKey },
    );
  }
}

export class StoreClosedError extends DomainException {
  constructor() {
    super('closed', HttpStatus.CONFLICT, 'El local está cerrado en este momento.');
  }
}

export class NotFoundDomainError extends DomainException {
  constructor(resource: string, id: string) {
    super('not_found', HttpStatus.NOT_FOUND, `${resource} ${id} no existe.`, { resource, id });
  }
}

export class InvalidStateTransitionError extends DomainException {
  constructor(resource: string, from: string, to: string) {
    super(
      'invalid_state_transition',
      HttpStatus.CONFLICT,
      `No se puede pasar ${resource} de '${from}' a '${to}'.`,
      { resource, from, to },
    );
  }
}
