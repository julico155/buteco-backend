import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Kysely, sql, Transaction } from 'kysely';
import { KYSELY } from '../database/database.module';
import {
  Database,
  ReservationDepositStatus,
  ReservationStatus,
} from '../database/types';
import {
  DomainException,
  NotFoundDomainError,
  ValidationError,
} from '../common/exceptions/domain-exception';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { dateInBolivia } from '../common/time/service-window';
import { localWeekdayAndMinute } from '../common/time/weekly-schedule';
import { QrPaymentsService } from '../bank-qr/qr-payments.service';
import { OperationalSettingsService } from '../operational-settings/operational-settings.service';
import { CreateReservationDto } from './dto/reservation.dto';
import {
  CandidateTable,
  depositOutcomeOnCancel,
  maxPartySize,
  overlaps,
  pickTable,
  ReservationTimingSettings,
  slotsForDate,
} from './reservation-rules';
import { isUniqueViolation } from './tables.service';
import { TableAccountsService, TableAccountResponse } from './table-accounts.service';

/** Estados que bloquean una mesa en el calendario. */
const BLOCKING_STATUSES: ReservationStatus[] = ['pending_payment', 'confirmed', 'seated'];

export interface ReservationSettingsView extends ReservationTimingSettings {
  enabled: boolean;
  depositAmount: number;
  paymentTtlMinutes: number;
}

/** Lo que ve el cliente: nunca la mesa. */
export interface PublicReservationResponse {
  id: string;
  reservationNumber: string;
  status: ReservationStatus;
  depositStatus: ReservationDepositStatus;
  partySize: number;
  customerName: string;
  startsAt: string;
  /** Hasta cuándo se puede pagar (pending_payment) o llegar (confirmed). */
  expiresAt: string;
  depositAmount: number;
  /** Pedido con el QR del adelanto: la imagen sale de GET /orders/:id/qr-image. */
  depositOrderId: string | null;
  notes: string | null;
}

export interface StaffReservationResponse extends PublicReservationResponse {
  customerPhone: string;
  tableId: string;
  tableLabel: string;
  tableSeats: number;
  blocksUntil: string;
  accountOrderId: string | null;
  cancelReason: string | null;
}

export interface AvailabilityResponse {
  date: string;
  partySize: number;
  maxPartySize: number;
  depositAmount: number;
  paymentTtlMinutes: number;
  slots: { startsAt: string; time: string }[];
}

type ReservationRow = {
  id: string;
  reservation_number: string;
  table_id: string;
  party_size: number;
  customer_name: string;
  customer_phone: string;
  notes: string | null;
  starts_at: Date | string;
  blocks_until: Date | string;
  expires_at: Date | string;
  status: ReservationStatus;
  deposit_amount: string;
  deposit_status: ReservationDepositStatus;
  deposit_order_id: string | null;
  account_order_id: string | null;
  cancel_reason: string | null;
};

const PHONE_RE = /^[+\d][\d\s().-]{4,28}$/;

@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly idempotency: IdempotencyService,
    private readonly qrPayments: QrPaymentsService,
    private readonly operationalSettings: OperationalSettingsService,
    private readonly accounts: TableAccountsService,
  ) {}

  // ---- Configuración ----

  async getSettings(db: Kysely<Database> = this.db): Promise<ReservationSettingsView> {
    const row = await db
      .selectFrom('reservation_settings')
      .selectAll()
      .where('id', '=', true)
      .executeTakeFirstOrThrow();
    return {
      enabled: row.enabled,
      depositAmount: Number(row.deposit_amount),
      slotMinutes: row.slot_minutes,
      blockMinutes: row.block_minutes,
      holdMinutes: row.hold_minutes,
      paymentTtlMinutes: row.payment_ttl_minutes,
      cancelRefundHours: row.cancel_refund_hours,
      minLeadMinutes: row.min_lead_minutes,
      maxDaysAhead: row.max_days_ahead,
      maxOccupancyPercent: row.max_occupancy_percent,
      lastSlotBeforeCloseMinutes: row.last_slot_before_close_minutes,
    };
  }

  async updateSettings(patch: Partial<ReservationSettingsView>): Promise<ReservationSettingsView> {
    await this.db
      .updateTable('reservation_settings')
      .set({
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.depositAmount !== undefined ? { deposit_amount: patch.depositAmount.toFixed(2) } : {}),
        ...(patch.slotMinutes !== undefined ? { slot_minutes: patch.slotMinutes } : {}),
        ...(patch.blockMinutes !== undefined ? { block_minutes: patch.blockMinutes } : {}),
        ...(patch.holdMinutes !== undefined ? { hold_minutes: patch.holdMinutes } : {}),
        ...(patch.paymentTtlMinutes !== undefined ? { payment_ttl_minutes: patch.paymentTtlMinutes } : {}),
        ...(patch.cancelRefundHours !== undefined ? { cancel_refund_hours: patch.cancelRefundHours } : {}),
        ...(patch.minLeadMinutes !== undefined ? { min_lead_minutes: patch.minLeadMinutes } : {}),
        ...(patch.maxDaysAhead !== undefined ? { max_days_ahead: patch.maxDaysAhead } : {}),
        ...(patch.maxOccupancyPercent !== undefined
          ? { max_occupancy_percent: patch.maxOccupancyPercent }
          : {}),
        ...(patch.lastSlotBeforeCloseMinutes !== undefined
          ? { last_slot_before_close_minutes: patch.lastSlotBeforeCloseMinutes }
          : {}),
        updated_at: new Date(),
      })
      .where('id', '=', true)
      .execute();
    return this.getSettings();
  }

  // ---- Disponibilidad (landing) ----

  async availability(date: string, partySize: number): Promise<AvailabilityResponse> {
    const settings = await this.getSettings();
    const tables = await this.activeTables(this.db);
    const maxParty = maxPartySize(tables);
    const base = {
      date,
      partySize,
      maxPartySize: maxParty,
      depositAmount: settings.depositAmount,
      paymentTtlMinutes: settings.paymentTtlMinutes,
    };
    if (!settings.enabled || partySize < 1 || partySize > maxParty) return { ...base, slots: [] };

    const slots = await this.openSlots(date, settings);
    if (slots.length === 0) return { ...base, slots: [] };

    const now = new Date();
    const windows = await this.blockingWindows(this.db, slots[0], this.endOf(slots[slots.length - 1], settings), now);
    const busy = await this.busyTableIds(this.db);

    const free = slots.filter((startsAt) => {
      const blocksUntil = this.endOf(startsAt, settings);
      return (
        pickTable({
          tables,
          windows,
          startsAt,
          blocksUntil,
          partySize,
          maxOccupancyPercent: settings.maxOccupancyPercent,
          busyTableIds: this.busyFor(startsAt, blocksUntil, busy, now),
        }) !== null
      );
    });
    return {
      ...base,
      slots: free.map((startsAt) => ({ startsAt: startsAt.toISOString(), time: localTime(startsAt) })),
    };
  }

  // ---- Crear (landing o staff) ----

  async create(
    dto: CreateReservationDto,
    idempotencyKey: string,
    apiClient: string,
    createdBy: string,
  ): Promise<{ created: boolean; body: PublicReservationResponse }> {
    const outcome = await this.idempotency.run<PublicReservationResponse>({
      apiClient,
      endpoint: 'POST /reservations',
      idempotencyKey,
      requestBody: dto,
      execute: async (trx) => {
        const body = await this.createInTransaction(trx, dto, createdBy);
        return { status: 201, body };
      },
    });

    // El QR se pide fuera de la transacción: es una llamada al banco.
    if (outcome.created && outcome.body.depositOrderId) {
      try {
        await this.qrPayments.generateForOrder(outcome.body.depositOrderId);
      } catch (error) {
        this.logger.warn(
          `No se pudo generar el QR del adelanto de ${outcome.body.reservationNumber}: ${(error as Error).message}`,
        );
        // Sin QR no hay forma de pagar: se libera la mesa y se avisa.
        await this.releasePending(outcome.body.id, 'expired', 'No se pudo generar el QR del adelanto');
        throw new DomainException(
          'qr_generation_failed',
          HttpStatus.BAD_GATEWAY,
          'No se pudo generar el QR del adelanto. Probá de nuevo en un momento.',
        );
      }
    }
    return { created: outcome.created, body: outcome.body };
  }

  private async createInTransaction(
    trx: Transaction<Database>,
    dto: CreateReservationDto,
    createdBy: string,
  ): Promise<PublicReservationResponse> {
    const settings = await this.getSettings(trx);
    if (!settings.enabled) {
      throw new DomainException(
        'reservations_disabled',
        HttpStatus.CONFLICT,
        'Por ahora no tomamos reservas.',
      );
    }

    const customerName = dto.customerName.trim();
    const customerPhone = dto.customerPhone.trim();
    if (!customerName) throw new ValidationError('El nombre es obligatorio.');
    if (!PHONE_RE.test(customerPhone)) throw new ValidationError('El teléfono no es válido.');

    const startsAt = new Date(dto.startsAt);
    if (Number.isNaN(startsAt.getTime())) throw new ValidationError('startsAt no es una fecha válida.');

    // Tiene que ser uno de los horarios que ofrece la disponibilidad: día de
    // atención, dentro del horario, en la grilla y con la anticipación mínima.
    const now = new Date();
    const slots = await this.openSlots(dateInBolivia(startsAt), settings, now);
    if (!slots.some((s) => s.getTime() === startsAt.getTime())) {
      throw new DomainException(
        'slot_not_available',
        HttpStatus.CONFLICT,
        'Ese horario no está disponible para reservar.',
        { startsAt: startsAt.toISOString() },
      );
    }

    // Serializa las reservas: bloquea las mesas activas en orden fijo.
    const tables = await this.activeTables(trx, true);
    const maxParty = maxPartySize(tables);
    if (dto.partySize > maxParty) {
      throw new DomainException(
        'party_too_large',
        HttpStatus.CONFLICT,
        `Reservamos para hasta ${maxParty} personas.`,
        { maxPartySize: maxParty },
      );
    }

    const blocksUntil = this.endOf(startsAt, settings);
    const windows = await this.blockingWindows(trx, startsAt, blocksUntil, now);
    const busy = await this.busyTableIds(trx);
    const table = pickTable({
      tables,
      windows,
      startsAt,
      blocksUntil,
      partySize: dto.partySize,
      maxOccupancyPercent: settings.maxOccupancyPercent,
      busyTableIds: this.busyFor(startsAt, blocksUntil, busy, now),
    });
    if (!table) {
      throw new DomainException(
        'no_availability',
        HttpStatus.CONFLICT,
        'No hay mesa disponible para ese horario.',
        { startsAt: startsAt.toISOString(), partySize: dto.partySize },
      );
    }

    const number = await sql<{ n: string }>`select nextval('reservation_number_seq') as n`.execute(trx);
    const reservationNumber = `RES-${String(number.rows[0].n).padStart(4, '0')}`;
    const needsDeposit = settings.depositAmount > 0;
    const expiresAt = needsDeposit
      ? new Date(now.getTime() + settings.paymentTtlMinutes * 60_000)
      : new Date(startsAt.getTime() + settings.holdMinutes * 60_000);

    const reservation = await trx
      .insertInto('reservations')
      .values({
        reservation_number: reservationNumber,
        table_id: table.id,
        party_size: dto.partySize,
        customer_name: customerName.slice(0, 100),
        customer_phone: customerPhone,
        notes: dto.notes?.trim() || null,
        starts_at: startsAt,
        blocks_until: blocksUntil,
        expires_at: expiresAt,
        status: needsDeposit ? 'pending_payment' : 'confirmed',
        deposit_amount: settings.depositAmount.toFixed(2),
        deposit_status: needsDeposit ? 'pending' : 'none',
        created_by: createdBy,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    let depositOrderId: string | null = null;
    if (needsDeposit) {
      const deposit = await trx
        .insertInto('orders')
        .values({
          order_number: reservationNumber,
          customer_id: null,
          channel: 'web',
          customer_name: `Reserva ${customerName}`.slice(0, 100),
          delivery_type: 'dine_in',
          payment_method: 'qr',
          status: 'confirmed',
          confirmed_at: now,
          subtotal_amount: settings.depositAmount.toFixed(2),
          total_amount: settings.depositAmount.toFixed(2),
          notes: `Adelanto de reserva ${reservationNumber}`,
          reservation_deposit: true,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      depositOrderId = deposit.id;
      await trx
        .updateTable('reservations')
        .set({ deposit_order_id: depositOrderId })
        .where('id', '=', reservation.id)
        .execute();
    }

    return toPublic({ ...reservation, deposit_order_id: depositOrderId });
  }

  // ---- Consulta ----

  /** Vista del cliente. Sincroniza el pago al consultar, así la landing ve el cambio de inmediato. */
  async getPublic(id: string): Promise<PublicReservationResponse> {
    await this.syncPayments(id);
    return toPublic(await this.requireRow(this.db, id));
  }

  async list(filter: { date?: string; status?: ReservationStatus }): Promise<StaffReservationResponse[]> {
    let query = this.db
      .selectFrom('reservations')
      .innerJoin('tables', 'tables.id', 'reservations.table_id')
      .selectAll('reservations')
      .select(['tables.label as table_label', 'tables.seats as table_seats'])
      .orderBy('reservations.starts_at');
    if (filter.status) query = query.where('reservations.status', '=', filter.status);
    if (filter.date) {
      const from = new Date(`${filter.date}T00:00:00-04:00`);
      if (Number.isNaN(from.getTime())) throw new ValidationError('date debe ser YYYY-MM-DD.');
      const to = new Date(from.getTime() + 24 * 60 * 60_000);
      query = query.where('reservations.starts_at', '>=', from).where('reservations.starts_at', '<', to);
    } else if (!filter.status) {
      // Sin filtro: lo que sigue vivo.
      query = query.where('reservations.status', 'in', BLOCKING_STATUSES);
    }
    const rows = await query.limit(500).execute();
    return rows.map((row) => toStaff(row, row.table_label, row.table_seats));
  }

  async getStaff(id: string): Promise<StaffReservationResponse> {
    await this.syncPayments(id);
    return this.staffView(this.db, id);
  }

  // ---- Cancelar ----

  /**
   * Cancela una reserva. Con el adelanto ya pagado: a 4 horas o más de la hora,
   * queda para devolver; después, se pierde. El staff puede forzar la
   * devolución (`refund`) cuando la culpa es del local.
   */
  async cancel(
    id: string,
    opts: { reason?: string; refund?: boolean; actor: string },
  ): Promise<StaffReservationResponse | PublicReservationResponse> {
    await this.syncPayments(id);
    const now = new Date();
    const settings = await this.getSettings();

    const result = await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('reservations')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw new NotFoundDomainError('reservation', id);

      if (row.status === 'seated') {
        throw new DomainException(
          'reservation_seated',
          HttpStatus.CONFLICT,
          'La reserva ya se sentó: no se puede cancelar.',
        );
      }
      if (row.status !== 'pending_payment' && row.status !== 'confirmed') {
        throw new DomainException(
          'reservation_closed',
          HttpStatus.CONFLICT,
          'La reserva ya no está activa.',
          { status: row.status },
        );
      }

      let depositStatus: ReservationDepositStatus = row.deposit_status;
      let cancelDepositOrder = false;
      if (row.status === 'pending_payment') {
        depositStatus = row.deposit_status === 'paid' ? 'paid' : 'none';
        cancelDepositOrder = true;
      } else if (row.deposit_status === 'paid') {
        depositStatus = opts.refund
          ? 'refund_due'
          : depositOutcomeOnCancel(now, new Date(row.starts_at), settings.cancelRefundHours);
        // Un adelanto que se devuelve deja de ser una venta.
        cancelDepositOrder = depositStatus === 'refund_due';
      }

      const updated = await trx
        .updateTable('reservations')
        .set({
          status: 'cancelled',
          deposit_status: depositStatus,
          cancelled_at: now,
          cancel_reason: opts.reason?.trim() || null,
          updated_at: now,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();

      if (cancelDepositOrder && row.deposit_order_id) {
        await trx
          .updateTable('orders')
          .set({ status: 'cancelled', status_updated_by: opts.actor, updated_at: now })
          .where('id', '=', row.deposit_order_id)
          .where('status', '!=', 'cancelled')
          .execute();
      }
      return { updated, qrOrderId: row.status === 'pending_payment' ? row.deposit_order_id : null };
    });

    if (result.qrOrderId) {
      this.qrPayments
        .cancelForOrder(result.qrOrderId)
        .catch((error: Error) =>
          this.logger.warn(`No se pudo cancelar el QR del adelanto ${result.qrOrderId}: ${error.message}`),
        );
    }
    return toPublic(result.updated);
  }

  // ---- Operación en el local ----

  /** El cliente llegó: se abre la cuenta de su mesa con el adelanto como crédito. */
  async seat(
    id: string,
    opts: { tableId?: string; staffUsername: string },
  ): Promise<TableAccountResponse> {
    await this.syncPayments(id);
    const tableId = await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('reservations')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw new NotFoundDomainError('reservation', id);
      if (row.status !== 'confirmed') {
        throw new DomainException(
          'reservation_not_confirmed',
          HttpStatus.CONFLICT,
          row.status === 'pending_payment'
            ? 'La reserva todavía no pagó el adelanto.'
            : 'La reserva no está confirmada.',
          { status: row.status },
        );
      }

      const target = opts.tableId ?? row.table_id;
      if (target !== row.table_id) {
        const tableRow = await trx
          .selectFrom('tables')
          .select(['id', 'seats', 'is_active'])
          .where('id', '=', target)
          .executeTakeFirst();
        if (!tableRow) throw new NotFoundDomainError('table', target);
        if (!tableRow.is_active || tableRow.seats < row.party_size) {
          throw new DomainException(
            'table_not_suitable',
            HttpStatus.CONFLICT,
            'La mesa elegida no está disponible o no alcanza para el grupo.',
          );
        }
      }

      try {
        const opened = await this.accounts.openInTransaction(trx, target, {
          customerName: row.customer_name,
          notes: `Reserva ${row.reservation_number}`,
          staffUsername: opts.staffUsername,
          depositCreditAmount: row.deposit_status === 'paid' ? Number(row.deposit_amount) : 0,
        });
        await trx
          .updateTable('reservations')
          .set({
            status: 'seated',
            table_id: target,
            account_order_id: opened.order.id,
            deposit_status: row.deposit_status === 'paid' ? 'applied' : row.deposit_status,
            updated_at: new Date(),
          })
          .where('id', '=', id)
          .execute();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new DomainException(
            'table_already_open',
            HttpStatus.CONFLICT,
            'La mesa ya tiene una cuenta abierta: elegí otra mesa.',
            { tableId: target },
          );
        }
        throw error;
      }
      return target;
    });
    return this.accounts.getAccount(tableId);
  }

  async markNoShow(id: string): Promise<StaffReservationResponse> {
    await this.syncPayments(id);
    await this.db.transaction().execute(async (trx) => {
      const row = await this.lockRow(trx, id);
      if (row.status !== 'confirmed') {
        throw new DomainException(
          'reservation_not_confirmed',
          HttpStatus.CONFLICT,
          'Solo una reserva confirmada puede marcarse como no presentada.',
          { status: row.status },
        );
      }
      await trx
        .updateTable('reservations')
        .set({ status: 'no_show', deposit_status: 'forfeited', updated_at: new Date() })
        .where('id', '=', id)
        .execute();
    });
    return this.staffView(this.db, id);
  }

  /** Ya se le devolvió la plata al cliente por fuera (el banco no tiene API de devolución). */
  async markRefunded(id: string): Promise<StaffReservationResponse> {
    const updated = await this.db
      .updateTable('reservations')
      .set({ deposit_status: 'refunded', updated_at: new Date() })
      .where('id', '=', id)
      .where('deposit_status', '=', 'refund_due')
      .returning('id')
      .executeTakeFirst();
    if (!updated) {
      await this.requireRow(this.db, id);
      throw new DomainException(
        'refund_not_due',
        HttpStatus.CONFLICT,
        'Esta reserva no tiene una devolución pendiente.',
      );
    }
    return this.staffView(this.db, id);
  }

  /** Cambia la mesa asignada (el cajero decide en el momento). */
  async move(id: string, tableId: string): Promise<StaffReservationResponse> {
    await this.db.transaction().execute(async (trx) => {
      const row = await this.lockRow(trx, id);
      if (row.status !== 'pending_payment' && row.status !== 'confirmed') {
        throw new DomainException(
          'reservation_closed',
          HttpStatus.CONFLICT,
          'Solo se puede mover una reserva activa.',
          { status: row.status },
        );
      }
      const tables = await this.activeTables(trx, true);
      const target = tables.find((t) => t.id === tableId);
      if (!target || target.seats < row.party_size) {
        throw new DomainException(
          'table_not_suitable',
          HttpStatus.CONFLICT,
          'La mesa no está activa o no alcanza para el grupo.',
        );
      }
      const windows = await this.blockingWindows(
        trx,
        new Date(row.starts_at),
        new Date(row.blocks_until),
        new Date(),
      );
      const clash = windows.some(
        (w) =>
          w.tableId === tableId &&
          overlaps(new Date(row.starts_at), new Date(row.blocks_until), w.startsAt, w.blocksUntil),
      );
      if (clash) {
        throw new DomainException(
          'table_taken',
          HttpStatus.CONFLICT,
          'Esa mesa ya tiene una reserva en ese horario.',
        );
      }
      await trx
        .updateTable('reservations')
        .set({ table_id: tableId, updated_at: new Date() })
        .where('id', '=', id)
        .execute();
    });
    return this.staffView(this.db, id);
  }

  // ---- Procesos periódicos ----

  /** Adelantos ya pagados: la reserva pasa a confirmada y empieza su plazo de espera. */
  async syncPayments(onlyId?: string): Promise<number> {
    let query = this.db
      .selectFrom('reservations')
      .innerJoin('orders', 'orders.id', 'reservations.deposit_order_id')
      .select(['reservations.id as id', 'reservations.starts_at as starts_at'])
      .where('reservations.status', '=', 'pending_payment')
      .where('orders.payment_status', '=', 'paid')
      .where('orders.status', '!=', 'cancelled');
    if (onlyId) query = query.where('reservations.id', '=', onlyId);
    const paid = await query.execute();
    if (paid.length === 0) return 0;

    const settings = await this.getSettings();
    let confirmed = 0;
    for (const reservation of paid) {
      const expiresAt = new Date(
        new Date(reservation.starts_at).getTime() + settings.holdMinutes * 60_000,
      );
      const result = await this.db
        .updateTable('reservations')
        .set({ status: 'confirmed', deposit_status: 'paid', expires_at: expiresAt, updated_at: new Date() })
        .where('id', '=', reservation.id)
        .where('status', '=', 'pending_payment')
        .returning('id')
        .executeTakeFirst();
      if (result) confirmed += 1;
    }
    return confirmed;
  }

  /** Reservas que no pagaron el adelanto a tiempo: se libera la mesa. */
  async expirePendingPayments(): Promise<number> {
    await this.syncPayments();
    const stale = await this.db
      .selectFrom('reservations')
      .select('id')
      .where('status', '=', 'pending_payment')
      .where('expires_at', '<', new Date())
      .limit(100)
      .execute();
    let expired = 0;
    for (const reservation of stale) {
      if (await this.releasePending(reservation.id, 'expired', 'No pagó el adelanto a tiempo')) {
        expired += 1;
      }
    }
    return expired;
  }

  /** Confirmadas que no se presentaron dentro del plazo: pierden el adelanto. */
  async markNoShows(): Promise<number> {
    const result = await this.db
      .updateTable('reservations')
      .set({ status: 'no_show', deposit_status: 'forfeited', updated_at: new Date() })
      .where('status', '=', 'confirmed')
      .where('expires_at', '<', new Date())
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  // ---- internos ----

  /** Libera una reserva sin pagar y cancela su QR. Devuelve false si ya no estaba pendiente. */
  private async releasePending(
    id: string,
    status: 'expired' | 'cancelled',
    reason: string,
  ): Promise<boolean> {
    const now = new Date();
    const released = await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('reservations')
        .select(['id', 'deposit_order_id'])
        .where('id', '=', id)
        .where('status', '=', 'pending_payment')
        .forUpdate()
        .executeTakeFirst();
      if (!row) return null;

      // Si el pago entró justo ahora, no se libera: el sondeo la confirma.
      if (row.deposit_order_id) {
        const deposit = await trx
          .selectFrom('orders')
          .select('payment_status')
          .where('id', '=', row.deposit_order_id)
          .executeTakeFirst();
        if (deposit?.payment_status === 'paid') return null;
        await trx
          .updateTable('orders')
          .set({ status: 'cancelled', status_updated_by: 'system', updated_at: now })
          .where('id', '=', row.deposit_order_id)
          .execute();
      }
      await trx
        .updateTable('reservations')
        .set({
          status,
          deposit_status: 'none',
          cancelled_at: now,
          cancel_reason: reason,
          updated_at: now,
        })
        .where('id', '=', id)
        .execute();
      return row;
    });
    if (!released) return false;
    if (released.deposit_order_id) {
      this.qrPayments
        .cancelForOrder(released.deposit_order_id)
        .catch((error: Error) =>
          this.logger.warn(`No se pudo cancelar el QR de ${released.deposit_order_id}: ${error.message}`),
        );
    }
    return true;
  }

  private endOf(startsAt: Date, settings: Pick<ReservationTimingSettings, 'blockMinutes'>): Date {
    return new Date(startsAt.getTime() + settings.blockMinutes * 60_000);
  }

  private async openSlots(
    date: string,
    settings: ReservationSettingsView,
    now: Date = new Date(),
  ): Promise<Date[]> {
    const operational = await this.operationalSettings.getRow();
    const dayStart = new Date(`${date}T12:00:00-04:00`);
    const local = localWeekdayAndMinute(dayStart);
    if (!local || !(operational.open_weekdays ?? [0, 1, 2, 3, 4, 5, 6]).includes(local.weekday)) {
      return [];
    }
    return slotsForDate({
      date,
      now,
      opensAtMinute: operational.business_opens_hour * 60,
      closesAtMinute: operational.business_closes_hour * 60,
      settings,
    });
  }

  private async activeTables(db: Kysely<Database>, lock = false): Promise<CandidateTable[]> {
    let query = db
      .selectFrom('tables')
      .select(['id', 'seats', 'label'])
      .where('is_active', '=', true)
      .orderBy('id');
    if (lock) query = query.forUpdate();
    return query.execute();
  }

  private async blockingWindows(db: Kysely<Database>, from: Date, to: Date, now: Date) {
    const rows = await db
      .selectFrom('reservations')
      .select(['table_id', 'starts_at', 'blocks_until', 'status', 'expires_at'])
      .where('status', 'in', BLOCKING_STATUSES)
      .where('starts_at', '<', to)
      .where('blocks_until', '>', from)
      .execute();
    return rows
      // Un adelanto sin pagar que ya pasó su plazo no bloquea (lo libera el cron).
      .filter((r) => !(r.status === 'pending_payment' && new Date(r.expires_at) < now))
      .map((r) => ({
        tableId: r.table_id,
        startsAt: new Date(r.starts_at),
        blocksUntil: new Date(r.blocks_until),
      }));
  }

  /** Mesas con una cuenta viva ahora, sin reserva detrás (clientes que llegaron sin reservar). */
  private async busyTableIds(db: Kysely<Database>): Promise<Set<string>> {
    const rows = await db
      .selectFrom('orders')
      .select('table_id')
      .where('table_id', 'is not', null)
      .where('status', 'in', ['open', 'confirmed'])
      .where('payment_status', '<>', 'paid')
      .execute();
    return new Set(rows.map((r) => r.table_id as string));
  }

  /**
   * Una mesa ocupada ahora por un cliente sin reserva sigue tomada más o menos
   * lo que dura un servicio: solo pesa sobre horarios que empiezan dentro de
   * ese margen. Más adelante no se puede prometer nada sobre ella.
   */
  private busyFor(startsAt: Date, blocksUntil: Date, busy: Set<string>, now: Date): Set<string> {
    const serviceMs = blocksUntil.getTime() - startsAt.getTime();
    return startsAt.getTime() < now.getTime() + serviceMs ? busy : new Set<string>();
  }

  private async requireRow(db: Kysely<Database>, id: string): Promise<ReservationRow> {
    const row = await db.selectFrom('reservations').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundDomainError('reservation', id);
    return row;
  }

  private async lockRow(trx: Transaction<Database>, id: string): Promise<ReservationRow> {
    const row = await trx
      .selectFrom('reservations')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new NotFoundDomainError('reservation', id);
    return row;
  }

  private async staffView(db: Kysely<Database>, id: string): Promise<StaffReservationResponse> {
    const row = await db
      .selectFrom('reservations')
      .innerJoin('tables', 'tables.id', 'reservations.table_id')
      .selectAll('reservations')
      .select(['tables.label as table_label', 'tables.seats as table_seats'])
      .where('reservations.id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundDomainError('reservation', id);
    return toStaff(row, row.table_label, row.table_seats);
  }
}

function localTime(instant: Date): string {
  const local = localWeekdayAndMinute(instant);
  if (!local) return '';
  const h = String(Math.floor(local.minute / 60)).padStart(2, '0');
  const m = String(local.minute % 60).padStart(2, '0');
  return `${h}:${m}`;
}

function toPublic(row: ReservationRow): PublicReservationResponse {
  return {
    id: row.id,
    reservationNumber: row.reservation_number,
    status: row.status,
    depositStatus: row.deposit_status,
    partySize: row.party_size,
    customerName: row.customer_name,
    startsAt: new Date(row.starts_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    depositAmount: Number(row.deposit_amount),
    depositOrderId: row.deposit_order_id,
    notes: row.notes,
  };
}

function toStaff(row: ReservationRow, tableLabel: string, tableSeats: number): StaffReservationResponse {
  return {
    ...toPublic(row),
    customerPhone: row.customer_phone,
    tableId: row.table_id,
    tableLabel,
    tableSeats,
    blocksUntil: new Date(row.blocks_until).toISOString(),
    accountOrderId: row.account_order_id,
    cancelReason: row.cancel_reason,
  };
}
