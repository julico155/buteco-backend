import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { JwtPayload } from './auth.service';
import { StaffRequest } from './jwt-auth.guard';

/** Staff autenticado por JwtAuthGuard (nunca usar sin el guard activo). */
export const CurrentStaffUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload => {
    const request = ctx.switchToHttp().getRequest<StaffRequest>();
    return request.staffUser;
  },
);
