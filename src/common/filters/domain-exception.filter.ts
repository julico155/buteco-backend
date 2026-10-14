import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { DomainException } from '../exceptions/domain-exception';

/**
 * Traduce cualquier excepción a { code, message, details } — invariante 8
 * del plan. Nunca deja pasar un stack trace o un error crudo de Postgres
 * al cliente.
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof DomainException) {
      const status = exception.getStatus();
      response.status(status).json({
        code: exception.code,
        message: exception.message,
        details: exception.details ?? null,
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      response
        .status(status)
        .json(
          typeof body === 'string'
            ? { code: 'http_error', message: body, details: null }
            : { code: 'http_error', details: null, ...body },
        );
      return;
    }

    this.logger.error(
      'Unhandled exception',
      exception instanceof Error ? exception.stack : exception,
    );
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      code: 'internal_error',
      message: 'Error interno.',
      details: null,
    });
  }
}
