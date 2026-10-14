import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { Request } from 'express';
import { AppConfig } from '../../config/configuration';

export interface AuthenticatedRequest extends Request {
  apiClient: string;
}

/**
 * Autenticación entre servicios: bearer token estático por api_client
 * (mismo patrón que VERCEL_INTERNAL_TOKEN hoy), comparación timing-safe.
 */
@Injectable()
export class ServiceAuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers['authorization'];
    const token = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '') : undefined;

    if (!token) {
      throw new UnauthorizedException('Falta el header Authorization: Bearer <token>.');
    }

    const tokens = this.config.get('serviceAuth', { infer: true }).tokens;
    const apiClient = Object.entries(tokens).find(([, candidate]) =>
      timingSafeCompare(candidate, token),
    )?.[0];

    if (!apiClient) {
      throw new UnauthorizedException('Token inválido.');
    }

    request.apiClient = apiClient;
    return true;
  }
}

function timingSafeCompare(expected: string, actual: string): boolean {
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(actual);
  if (expectedBuf.length !== actualBuf.length) {
    // Igual comparamos contra sí mismo para no filtrar la longitud por timing.
    timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }
  return timingSafeEqual(expectedBuf, actualBuf);
}
