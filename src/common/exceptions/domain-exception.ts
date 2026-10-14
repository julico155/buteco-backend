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
  constructor(
    productId: string,
    reason: 'inactive' | 'sold_out',
    unavailableProductIds?: string[],
  ) {
    super(
      'product_unavailable',
      HttpStatus.CONFLICT,
      `El producto ${productId} no está disponible (${reason}).`,
      { productId, reason, unavailableProductIds: unavailableProductIds ?? [productId] },
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
