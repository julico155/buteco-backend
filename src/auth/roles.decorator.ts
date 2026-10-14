import { SetMetadata } from '@nestjs/common';
import { DashboardUserRole } from '../database/types';

export const ROLES_KEY = 'roles';

/** Usar junto a JwtAuthGuard + RolesGuard: @Roles('admin') restringe el endpoint a ese rol. */
export const Roles = (...roles: DashboardUserRole[]) => SetMetadata(ROLES_KEY, roles);
