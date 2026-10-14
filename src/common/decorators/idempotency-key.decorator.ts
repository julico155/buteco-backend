import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { ValidationError } from '../exceptions/domain-exception';

/** Header `Idempotency-Key` — ver IdempotencyService e invariante 2 del plan. */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const header = request.headers['idempotency-key'];
    const key = Array.isArray(header) ? header[0] : header;
    if (!key) {
      throw new ValidationError('Falta el header Idempotency-Key.');
    }
    return key;
  },
);
