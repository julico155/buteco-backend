import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedRequest } from '../guards/service-auth.guard';

/** api_client resuelto por ServiceAuthGuard (nunca usar sin el guard activo). */
export const ApiClient = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  return request.apiClient;
});
