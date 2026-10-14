import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { AuthenticatedRequest, ServiceAuthGuard } from './service-auth.guard';

/**
 * api_client con el que quedan marcadas las requests autenticadas por JWT de
 * staff. Es el scope de idempotencia de POST /orders: sin un valor estable,
 * una venta reintentada por timeout de red se cobraría dos veces.
 */
export const STAFF_API_CLIENT = 'pos';

/**
 * Acepta el bearer estático entre servicios (gateway de WhatsApp) o el JWT de
 * staff (POS/dashboard). Los dos leen el mismo header `Authorization`, así que
 * se intenta primero el de servicio, que resuelve en memoria.
 */
@Injectable()
export class ServiceOrStaffAuthGuard implements CanActivate {
  constructor(
    private readonly serviceAuth: ServiceAuthGuard,
    private readonly jwtAuth: JwtAuthGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      return this.serviceAuth.canActivate(context);
    } catch {
      // No es un token de servicio: puede ser un JWT de staff.
    }

    await this.jwtAuth.canActivate(context);
    const request = context.switchToHttp().getRequest<AuthenticatedRequest & { staffUser?: { role: string } }>();
    // El repartidor solo usa /delivery/orders/*: nada de clientes, pedidos ni catálogo con su JWT.
    if (request.staffUser?.role === 'delivery') {
      throw new ForbiddenException('El rol delivery no tiene acceso a este recurso.');
    }
    request.apiClient = STAFF_API_CLIENT;
    return true;
  }
}
