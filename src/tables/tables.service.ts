import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database, OrderStatus, TableShape } from '../database/types';
import { DomainException, NotFoundDomainError } from '../common/exceptions/domain-exception';
import { CreateFloorDto, UpdateFloorDto } from './dto/floor.dto';
import { CreateTableDto, SaveLayoutDto, UpdateTableDto } from './dto/table.dto';
import { deriveTableState, TableState } from './table-state';

export interface FloorResponse {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

export interface TableAccountSummary {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  totalAmount: number;
  itemsCount: number;
  openedAt: string;
  billRequestedAt: string | null;
}

export interface TableResponse {
  id: string;
  floorId: string;
  label: string;
  seats: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  shape: TableShape;
  isActive: boolean;
  /** Deducido de la cuenta viva; nunca se guarda. */
  state: TableState;
  account: TableAccountSummary | null;
}

interface TableRow {
  id: string;
  floor_id: string;
  label: string;
  seats: number;
  x: string;
  y: string;
  width: string;
  height: string;
  rotation: string;
  shape: TableShape;
  is_active: boolean;
}

export function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505';
}

@Injectable()
export class TablesService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  // ---- Ambientes ----

  async listFloors(includeInactive = false): Promise<FloorResponse[]> {
    let query = this.db.selectFrom('floors').selectAll();
    if (!includeInactive) query = query.where('is_active', '=', true);
    const rows = await query.orderBy('sort_order').orderBy('name').execute();
    return rows.map(toFloorResponse);
  }

  async createFloor(dto: CreateFloorDto): Promise<FloorResponse> {
    try {
      const row = await this.db
        .insertInto('floors')
        .values({ name: dto.name.trim(), sort_order: dto.sortOrder ?? 0 })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toFloorResponse(row);
    } catch (error) {
      throw this.translateDuplicate(error, 'floor_name_taken', 'Ya existe un ambiente con ese nombre.');
    }
  }

  async updateFloor(id: string, dto: UpdateFloorDto): Promise<FloorResponse> {
    if (dto.isActive === false) await this.assertNoLiveAccountsOnFloor(id);
    try {
      const row = await this.db
        .updateTable('floors')
        .set({
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.sortOrder !== undefined ? { sort_order: dto.sortOrder } : {}),
          ...(dto.isActive !== undefined ? { is_active: dto.isActive } : {}),
          updated_at: new Date(),
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
      if (!row) throw new NotFoundDomainError('floor', id);
      return toFloorResponse(row);
    } catch (error) {
      throw this.translateDuplicate(error, 'floor_name_taken', 'Ya existe un ambiente con ese nombre.');
    }
  }

  async deleteFloor(id: string): Promise<void> {
    const hasTables = await this.db
      .selectFrom('tables')
      .select('id')
      .where('floor_id', '=', id)
      .executeTakeFirst();
    if (hasTables) {
      throw new DomainException(
        'floor_not_empty',
        HttpStatus.CONFLICT,
        'El ambiente tiene mesas: movelas o desactivalo en vez de borrarlo.',
      );
    }
    const deleted = await this.db
      .deleteFrom('floors')
      .where('id', '=', id)
      .returning('id')
      .executeTakeFirst();
    if (!deleted) throw new NotFoundDomainError('floor', id);
  }

  // ---- Mesas ----

  async listTables(
    filter: { floorId?: string; includeInactive?: boolean } = {},
  ): Promise<TableResponse[]> {
    let query = this.db.selectFrom('tables').selectAll();
    if (filter.floorId) query = query.where('floor_id', '=', filter.floorId);
    if (!filter.includeInactive) query = query.where('is_active', '=', true);
    const tables = await query.orderBy('label').execute();
    if (tables.length === 0) return [];
    return this.withAccounts(tables);
  }

  async findTable(id: string): Promise<TableResponse> {
    const table = await this.db
      .selectFrom('tables')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!table) throw new NotFoundDomainError('table', id);
    return (await this.withAccounts([table]))[0];
  }

  async createTable(dto: CreateTableDto): Promise<TableResponse> {
    await this.assertFloorExists(dto.floorId);
    try {
      const row = await this.db
        .insertInto('tables')
        .values({
          floor_id: dto.floorId,
          label: dto.label.trim(),
          ...(dto.seats !== undefined ? { seats: dto.seats } : {}),
          ...(dto.x !== undefined ? { x: dto.x.toFixed(2) } : {}),
          ...(dto.y !== undefined ? { y: dto.y.toFixed(2) } : {}),
          ...(dto.width !== undefined ? { width: dto.width.toFixed(2) } : {}),
          ...(dto.height !== undefined ? { height: dto.height.toFixed(2) } : {}),
          ...(dto.rotation !== undefined ? { rotation: dto.rotation.toFixed(2) } : {}),
          ...(dto.shape !== undefined ? { shape: dto.shape } : {}),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return (await this.withAccounts([row]))[0];
    } catch (error) {
      throw this.translateDuplicate(error, 'table_label_taken', 'Ya hay una mesa con ese nombre en el ambiente.');
    }
  }

  async updateTable(id: string, dto: UpdateTableDto): Promise<TableResponse> {
    if (dto.isActive === false || dto.floorId !== undefined) await this.assertNoLiveAccount(id);
    if (dto.floorId !== undefined) await this.assertFloorExists(dto.floorId);
    try {
      const row = await this.db
        .updateTable('tables')
        .set({
          ...(dto.floorId !== undefined ? { floor_id: dto.floorId } : {}),
          ...(dto.label !== undefined ? { label: dto.label.trim() } : {}),
          ...(dto.seats !== undefined ? { seats: dto.seats } : {}),
          ...(dto.x !== undefined ? { x: dto.x.toFixed(2) } : {}),
          ...(dto.y !== undefined ? { y: dto.y.toFixed(2) } : {}),
          ...(dto.width !== undefined ? { width: dto.width.toFixed(2) } : {}),
          ...(dto.height !== undefined ? { height: dto.height.toFixed(2) } : {}),
          ...(dto.rotation !== undefined ? { rotation: dto.rotation.toFixed(2) } : {}),
          ...(dto.shape !== undefined ? { shape: dto.shape } : {}),
          ...(dto.isActive !== undefined ? { is_active: dto.isActive } : {}),
          updated_at: new Date(),
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
      if (!row) throw new NotFoundDomainError('table', id);
      return (await this.withAccounts([row]))[0];
    } catch (error) {
      throw this.translateDuplicate(error, 'table_label_taken', 'Ya hay una mesa con ese nombre en el ambiente.');
    }
  }

  /** Solo mesas sin historial: si ya tuvo cuentas se desactiva (los pedidos viejos la referencian). */
  async deleteTable(id: string): Promise<void> {
    const used = await this.db
      .selectFrom('orders')
      .select('id')
      .where('table_id', '=', id)
      .limit(1)
      .executeTakeFirst();
    if (used) {
      throw new DomainException(
        'table_has_history',
        HttpStatus.CONFLICT,
        'La mesa ya tuvo cuentas: desactivala en vez de borrarla.',
      );
    }
    const deleted = await this.db
      .deleteFrom('tables')
      .where('id', '=', id)
      .returning('id')
      .executeTakeFirst();
    if (!deleted) throw new NotFoundDomainError('table', id);
  }

  /** Guarda posiciones de varias mesas en una sola transacción: o todas o ninguna. */
  async saveLayout(dto: SaveLayoutDto): Promise<TableResponse[]> {
    const ids = dto.tables.map((t) => t.id);
    if (new Set(ids).size !== ids.length) {
      throw new DomainException('duplicate_tables', HttpStatus.BAD_REQUEST, 'El plano repite una mesa.');
    }
    await this.db.transaction().execute(async (trx) => {
      for (const item of dto.tables) {
        const updated = await trx
          .updateTable('tables')
          .set({
            x: item.x.toFixed(2),
            y: item.y.toFixed(2),
            ...(item.width !== undefined ? { width: item.width.toFixed(2) } : {}),
            ...(item.height !== undefined ? { height: item.height.toFixed(2) } : {}),
            ...(item.rotation !== undefined ? { rotation: item.rotation.toFixed(2) } : {}),
            updated_at: new Date(),
          })
          .where('id', '=', item.id)
          .returning('id')
          .executeTakeFirst();
        if (!updated) throw new NotFoundDomainError('table', item.id);
      }
    });
    return this.listTables({ includeInactive: true });
  }

  // ---- internos ----

  private async withAccounts(tables: TableRow[]): Promise<TableResponse[]> {
    const accounts = await this.db
      .selectFrom('orders')
      .select([
        'id',
        'table_id',
        'order_number',
        'status',
        'total_amount',
        'created_at',
        'bill_requested_at',
      ])
      .where('table_id', 'in', tables.map((t) => t.id))
      .where('status', 'in', ['open', 'confirmed'])
      .where('payment_status', '<>', 'paid')
      .execute();

    const counts =
      accounts.length === 0
        ? []
        : await this.db
            .selectFrom('order_items')
            .select(['order_id', sql<string>`sum(quantity)`.as('quantity')])
            .where('order_id', 'in', accounts.map((a) => a.id))
            .where('voided_at', 'is', null)
            .groupBy('order_id')
            .execute();
    const countByOrder = new Map(counts.map((c) => [c.order_id, Number(c.quantity)]));
    const accountByTable = new Map(accounts.map((a) => [a.table_id as string, a]));

    return tables.map((table) => {
      const account = accountByTable.get(table.id) ?? null;
      return {
        id: table.id,
        floorId: table.floor_id,
        label: table.label,
        seats: table.seats,
        x: Number(table.x),
        y: Number(table.y),
        width: Number(table.width),
        height: Number(table.height),
        rotation: Number(table.rotation),
        shape: table.shape,
        isActive: table.is_active,
        state: deriveTableState({
          isActive: table.is_active,
          account: account
            ? { status: account.status, billRequestedAt: account.bill_requested_at }
            : null,
        }),
        account: account
          ? {
              orderId: account.id,
              orderNumber: account.order_number,
              status: account.status,
              totalAmount: Number(account.total_amount),
              itemsCount: countByOrder.get(account.id) ?? 0,
              openedAt: new Date(account.created_at).toISOString(),
              billRequestedAt: account.bill_requested_at
                ? new Date(account.bill_requested_at).toISOString()
                : null,
            }
          : null,
      };
    });
  }

  private async assertFloorExists(floorId: string): Promise<void> {
    const floor = await this.db
      .selectFrom('floors')
      .select('id')
      .where('id', '=', floorId)
      .executeTakeFirst();
    if (!floor) throw new NotFoundDomainError('floor', floorId);
  }

  private async assertNoLiveAccount(tableId: string): Promise<void> {
    const live = await this.db
      .selectFrom('orders')
      .select('id')
      .where('table_id', '=', tableId)
      .where('status', 'in', ['open', 'confirmed'])
      .where('payment_status', '<>', 'paid')
      .executeTakeFirst();
    if (live) {
      throw new DomainException(
        'table_has_open_account',
        HttpStatus.CONFLICT,
        'La mesa tiene una cuenta abierta: cobrala o cancelala primero.',
      );
    }
  }

  private async assertNoLiveAccountsOnFloor(floorId: string): Promise<void> {
    const live = await this.db
      .selectFrom('orders')
      .innerJoin('tables', 'tables.id', 'orders.table_id')
      .select('orders.id')
      .where('tables.floor_id', '=', floorId)
      .where('orders.status', 'in', ['open', 'confirmed'])
      .where('orders.payment_status', '<>', 'paid')
      .executeTakeFirst();
    if (live) {
      throw new DomainException(
        'floor_has_open_accounts',
        HttpStatus.CONFLICT,
        'El ambiente tiene mesas con cuenta abierta.',
      );
    }
  }

  private translateDuplicate(error: unknown, code: string, message: string): unknown {
    if (isUniqueViolation(error)) return new DomainException(code, HttpStatus.CONFLICT, message);
    return error;
  }
}

function toFloorResponse(row: {
  id: string;
  name: string;
  sort_order: number;
  is_active: boolean;
}): FloorResponse {
  return { id: row.id, name: row.name, sortOrder: row.sort_order, isActive: row.is_active };
}
