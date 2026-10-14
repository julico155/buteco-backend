import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DashboardUserRole } from '../database/types';
import { ROLES_KEY } from './roles.decorator';
import { StaffRequest } from './jwt-auth.guard';

/** Debe ir DESPUÉS de JwtAuthGuard en @UseGuards — depende de request.staffUser. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<DashboardUserRole[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const request = context.switchToHttp().getRequest<StaffRequest>();

    // Sin staffUser la request se autenticó con el bearer estático entre
    // servicios (ServiceOrStaffAuthGuard): no tiene rol, y ese token ya es
    // confianza total entre backends.
    if (!request.staffUser) return true;

    if (!requiredRoles.includes(request.staffUser.role)) {
      throw new ForbiddenException(`Requiere rol: ${requiredRoles.join(' o ')}.`);
    }
    return true;
  }
}
