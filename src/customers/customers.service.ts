import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';
import {
  DomainException,
  NotFoundDomainError,
  ValidationError,
} from '../common/exceptions/domain-exception';
import { FindOrCreateCustomerDto } from './dto/find-or-create-customer.dto';
import { normalizePhone } from './normalize-phone';

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

export interface CustomerResponse {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
}

@Injectable()
export class CustomersService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async findById(id: string): Promise<CustomerResponse> {
    const row = await this.db
      .selectFrom('customers')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundDomainError('customer', id);
    return toCustomerResponse(row);
  }

  async findByPhone(phone: string): Promise<CustomerResponse | null> {
    const row = await this.db
      .selectFrom('customers')
      .selectAll()
      .where('phone', '=', normalizePhone(phone))
      .executeTakeFirst();
    return row ? toCustomerResponse(row) : null;
  }

  /**
   * Resuelve o crea el cliente. Cada canal decide qué identificador tiene a
   * mano: el gateway de WhatsApp llama con `phone`; el POS puede llamar sin
   * nada ("cliente genérico") o pedir el teléfono.
   *
   * Si llegan phone Y email y cada uno ya pertenece a un customer DISTINTO,
   * el INSERT por phone (que no choca en phone) viola igual el unique(email)
   * — ese caso no se fusiona automáticamente (fusionar identidades sin
   * confirmación humana es más peligroso que rechazar), se traduce a un
   * 409 de dominio en vez de dejar escapar el error crudo de Postgres.
   */
  async findOrCreate(rawDto: FindOrCreateCustomerDto): Promise<CustomerResponse> {
    const dto: FindOrCreateCustomerDto = {
      ...rawDto,
      phone: rawDto.phone === undefined ? undefined : normalizePhone(rawDto.phone),
    };
    if (!dto.phone && !dto.email && !dto.name) {
      throw new ValidationError('Se requiere al menos uno de: phone, email, name.');
    }

    if (dto.phone) {
      const byPhone = await this.upsertByUniqueColumn('phone', dto.phone, dto);
      if (byPhone) return byPhone;
    }
    if (dto.email) {
      const byEmail = await this.upsertByUniqueColumn('email', dto.email, dto);
      if (byEmail) return byEmail;
    }

    const created = await this.db
      .insertInto('customers')
      .values({ name: dto.name, phone: dto.phone, email: dto.email })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toCustomerResponse(created);
  }

  private async upsertByUniqueColumn(
    column: 'phone' | 'email',
    value: string,
    dto: FindOrCreateCustomerDto,
  ): Promise<CustomerResponse | null> {
    let inserted;
    try {
      inserted = await this.db
        .insertInto('customers')
        .values({ name: dto.name, phone: dto.phone, email: dto.email })
        .onConflict((oc) => oc.column(column).doNothing())
        .returningAll()
        .executeTakeFirst();
    } catch (error) {
      if (isUniqueViolation(error)) {
        const otherColumn = column === 'phone' ? 'email' : 'phone';
        throw new DomainException(
          'customer_identity_conflict',
          HttpStatus.CONFLICT,
          `El ${otherColumn} indicado ya pertenece a un cliente distinto del que tiene ese ${column}.`,
          { conflictingColumn: otherColumn },
        );
      }
      throw error;
    }

    if (inserted) return toCustomerResponse(inserted);

    const existing = await this.db
      .selectFrom('customers')
      .selectAll()
      .where(column, '=', value)
      .executeTakeFirst();
    return existing ? toCustomerResponse(existing) : null;
  }
}

function toCustomerResponse(row: {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
}): CustomerResponse {
  return { id: row.id, name: row.name, phone: row.phone, email: row.email };
}
