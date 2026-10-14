import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { JwtPayload } from './auth.service';

export interface StaffRequest extends Request {
  staffUser: JwtPayload;
}

/** Sesión de staff (dashboard/POS) autenticada por JWT — distinto del bearer estático entre servicios. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<StaffRequest>();
    const header = request.headers['authorization'];
    const token = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '') : undefined;

    if (!token) {
      throw new UnauthorizedException('Falta el header Authorization: Bearer <token>.');
    }

    try {
      request.staffUser = await this.jwt.verifyAsync<JwtPayload>(token);
      return true;
    } catch {
      throw new UnauthorizedException('Token inválido o vencido.');
    }
  }
}
