import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AppConfig } from '../../config/configuration';
import { JwtAuthGuard, StaffRequest } from '../../auth/jwt-auth.guard';
import { AuthenticatedRequest, ServiceAuthGuard } from './service-auth.guard';
import { ServiceOrStaffAuthGuard, STAFF_API_CLIENT } from './service-or-staff-auth.guard';

type GuardedRequest = AuthenticatedRequest & StaffRequest;

function contextWithHeader(authorization?: string): ExecutionContext {
  const request = { headers: { authorization } } as unknown as GuardedRequest;
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const STAFF_PAYLOAD = { sub: 'user-1', username: 'juli', role: 'cashier' as const };

function buildGuard(): ServiceOrStaffAuthGuard {
  const config = {
    get: () => ({ tokens: { 'whatsapp-gateway': 'wa-token' } }),
  } as unknown as ConfigService<AppConfig, true>;
  const jwt = {
    verifyAsync: (token: string) =>
      token === 'staff-jwt'
        ? Promise.resolve(STAFF_PAYLOAD)
        : token === 'driver-jwt'
          ? Promise.resolve({ sub: 'user-2', username: 'moto', role: 'delivery' })
          : Promise.reject(new Error('invalid')),
  } as unknown as JwtService;

  return new ServiceOrStaffAuthGuard(new ServiceAuthGuard(config), new JwtAuthGuard(jwt));
}

describe('ServiceOrStaffAuthGuard', () => {
  it('acepta el bearer estático entre servicios y resuelve su api_client', async () => {
    const context = contextWithHeader('Bearer wa-token');
    const request = context.switchToHttp().getRequest<GuardedRequest>();

    await expect(buildGuard().canActivate(context)).resolves.toBe(true);
    expect(request.apiClient).toBe('whatsapp-gateway');
    expect(request.staffUser).toBeUndefined();
  });

  it('acepta un JWT de staff cuando el token no es de servicio', async () => {
    const context = contextWithHeader('Bearer staff-jwt');
    const request = context.switchToHttp().getRequest<GuardedRequest>();

    await expect(buildGuard().canActivate(context)).resolves.toBe(true);
    expect(request.staffUser).toEqual(STAFF_PAYLOAD);
  });

  // El scope de idempotencia de POST /orders sale de apiClient: si queda sin
  // setear, un reintento por timeout de red cobraría la venta dos veces.
  it('marca las requests de staff con un api_client estable', async () => {
    const context = contextWithHeader('Bearer staff-jwt');
    const request = context.switchToHttp().getRequest<GuardedRequest>();

    await buildGuard().canActivate(context);
    expect(request.apiClient).toBe(STAFF_API_CLIENT);
  });

  it('rechaza el JWT de un repartidor: solo usa /delivery/orders/*', async () => {
    await expect(buildGuard().canActivate(contextWithHeader('Bearer driver-jwt'))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('rechaza un token que no es ni de servicio ni un JWT válido', async () => {
    await expect(buildGuard().canActivate(contextWithHeader('Bearer basura'))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rechaza si falta el header Authorization', async () => {
    await expect(buildGuard().canActivate(contextWithHeader(undefined))).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
