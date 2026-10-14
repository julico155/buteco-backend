import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DashboardUserRole } from '../database/types';
import { StaffRequest } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';

function buildContext(staffUser?: { role: DashboardUserRole }): ExecutionContext {
  const request = { staffUser } as unknown as StaffRequest;
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function buildGuard(requiredRoles?: DashboardUserRole[]): RolesGuard {
  const reflector = {
    getAllAndOverride: () => requiredRoles,
  } as unknown as Reflector;
  return new RolesGuard(reflector);
}

describe('RolesGuard', () => {
  it('deja pasar cuando el endpoint no declara roles', () => {
    expect(buildGuard(undefined).canActivate(buildContext({ role: 'kitchen' }))).toBe(true);
  });

  it('deja pasar al staff con un rol permitido', () => {
    expect(buildGuard(['admin', 'cashier']).canActivate(buildContext({ role: 'cashier' }))).toBe(
      true,
    );
  });

  it('rechaza al staff con un rol no permitido', () => {
    expect(() => buildGuard(['admin']).canActivate(buildContext({ role: 'kitchen' }))).toThrow(
      ForbiddenException,
    );
  });

  // Con ServiceOrStaffAuthGuard la request puede venir del bearer entre
  // servicios: no tiene staffUser, y antes eso reventaba con un 500.
  it('deja pasar una request autenticada como servicio, que no tiene rol', () => {
    expect(buildGuard(['admin']).canActivate(buildContext(undefined))).toBe(true);
  });
});
