import { ArgumentsHost, HttpStatus, NotFoundException } from '@nestjs/common';
import { Response } from 'express';
import { DomainExceptionFilter } from './domain-exception.filter';
import { ProductUnavailableError } from '../exceptions/domain-exception';

function mockResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function hostWithResponse(response: Response): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
}

describe('DomainExceptionFilter (invariante 8: nunca texto crudo, siempre {code, message, details})', () => {
  it('traduce un DomainException a {code, message, details} con su status', () => {
    const filter = new DomainExceptionFilter();
    const response = mockResponse();
    const error = new ProductUnavailableError('prod-1', 'sold_out');

    filter.catch(error, hostWithResponse(response));

    expect(response.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(response.json).toHaveBeenCalledWith({
      code: 'product_unavailable',
      message: expect.any(String),
      details: { productId: 'prod-1', reason: 'sold_out', unavailableProductIds: ['prod-1'] },
    });
  });

  it('envuelve un HttpException genérico de Nest sin dejar pasar su forma cruda', () => {
    const filter = new DomainExceptionFilter();
    const response = mockResponse();

    filter.catch(new NotFoundException('no existe'), hostWithResponse(response));

    expect(response.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    const [body] = (response.json as jest.Mock).mock.calls[0];
    expect(body.code).toBeDefined();
    expect(body.details).toBeDefined();
  });

  it('nunca deja pasar un stack trace crudo para un error inesperado', () => {
    const filter = new DomainExceptionFilter();
    const response = mockResponse();

    filter.catch(new Error('boom: pg connection reset'), hostWithResponse(response));

    expect(response.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(response.json).toHaveBeenCalledWith({
      code: 'internal_error',
      message: 'Error interno.',
      details: null,
    });
  });
});
