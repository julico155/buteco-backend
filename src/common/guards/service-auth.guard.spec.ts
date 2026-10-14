import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthenticatedRequest, ServiceAuthGuard } from './service-auth.guard';
import { AppConfig } from '../../config/configuration';

function contextWithHeader(authorization?: string): ExecutionContext {
  const request = { headers: { authorization } } as unknown as AuthenticatedRequest;
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

function configWithTokens(tokens: Record<string, string>): ConfigService<AppConfig, true> {
  return {
    get: () => ({ tokens }),
  } as unknown as ConfigService<AppConfig, true>;
}

describe('ServiceAuthGuard', () => {
  it('rechaza si falta el header Authorization', () => {
    const guard = new ServiceAuthGuard(configWithTokens({ pos: 'secret-token' }));
    expect(() => guard.canActivate(contextWithHeader(undefined))).toThrow(UnauthorizedException);
  });

  it('rechaza un token que no coincide con ninguno configurado', () => {
    const guard = new ServiceAuthGuard(configWithTokens({ pos: 'secret-token' }));
    expect(() => guard.canActivate(contextWithHeader('Bearer wrong-token'))).toThrow(
      UnauthorizedException,
    );
  });

  it('rechaza un token de otra longitud sin lanzar por comparación insegura', () => {
    const guard = new ServiceAuthGuard(configWithTokens({ pos: 'secret-token' }));
    expect(() => guard.canActivate(contextWithHeader('Bearer short'))).toThrow(
      UnauthorizedException,
    );
  });

  it('acepta un token válido y resuelve el api_client correspondiente en la request', () => {
    const guard = new ServiceAuthGuard(
      configWithTokens({ pos: 'pos-token', 'whatsapp-gateway': 'wa-token' }),
    );
    const context = contextWithHeader('Bearer wa-token');
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    expect(guard.canActivate(context)).toBe(true);
    expect(request.apiClient).toBe('whatsapp-gateway');
  });
});
