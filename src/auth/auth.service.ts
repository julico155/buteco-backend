import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { Kysely } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database, DashboardUserRole } from '../database/types';
import { DomainException, NotFoundDomainError } from '../common/exceptions/domain-exception';
import { LoginDto } from './dto/login.dto';
import { CreateStaffUserDto } from './dto/create-staff-user.dto';

const BCRYPT_ROUNDS = 10;

export interface JwtPayload {
  sub: string;
  username: string;
  role: DashboardUserRole;
}

export interface LoginResponse {
  accessToken: string;
  user: { id: string; username: string; role: DashboardUserRole };
}

export interface StaffUserResponse {
  id: string;
  username: string;
  role: DashboardUserRole;
  isActive: boolean;
  createdAt: string;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

/** Cuentas de staff (dashboard_users, compartidas entre dashboard y POS). */
@Injectable()
export class AuthService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly jwt: JwtService,
  ) {}

  async login(dto: LoginDto): Promise<LoginResponse> {
    const user = await this.db
      .selectFrom('dashboard_users')
      .selectAll()
      .where('username', '=', dto.username)
      .executeTakeFirst();

    // Mismo mensaje genérico tanto si el usuario no existe como si la
    // contraseña es incorrecta — no revelar cuál de las dos falló.
    const invalidCredentials = () =>
      new DomainException(
        'invalid_credentials',
        HttpStatus.UNAUTHORIZED,
        'Usuario o contraseña incorrectos.',
      );

    if (!user || !user.is_active) throw invalidCredentials();

    const passwordMatches = await bcrypt.compare(dto.password, user.password_hash);
    if (!passwordMatches) throw invalidCredentials();

    const payload: JwtPayload = { sub: user.id, username: user.username, role: user.role };
    const accessToken = await this.jwt.signAsync(payload);

    return { accessToken, user: { id: user.id, username: user.username, role: user.role } };
  }

  /**
   * Provisión de cuentas de staff vía API en vez de SQL directo. Protegido
   * en el controller con @Roles('admin') — el primer admin sigue
   * requiriendo un INSERT manual (arranque en frío inevitable).
   */
  async createStaffUser(dto: CreateStaffUserDto): Promise<StaffUserResponse> {
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    try {
      const created = await this.db
        .insertInto('dashboard_users')
        .values({ username: dto.username, password_hash: passwordHash, role: dto.role })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toStaffUserResponse(created);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainException(
          'username_taken',
          HttpStatus.CONFLICT,
          `El usuario "${dto.username}" ya existe.`,
        );
      }
      throw error;
    }
  }

  async listStaffUsers(): Promise<StaffUserResponse[]> {
    const rows = await this.db
      .selectFrom('dashboard_users')
      .selectAll()
      .orderBy('username', 'asc')
      .execute();
    return rows.map(toStaffUserResponse);
  }

  async setActive(id: string, active: boolean): Promise<StaffUserResponse> {
    const updated = await this.db
      .updateTable('dashboard_users')
      .set({ is_active: active })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new NotFoundDomainError('dashboard_user', id);
    return toStaffUserResponse(updated);
  }
}

function toStaffUserResponse(row: {
  id: string;
  username: string;
  role: DashboardUserRole;
  is_active: boolean;
  created_at: Date | string;
}): StaffUserResponse {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    isActive: row.is_active,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
