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
import { dateInBolivia, startOfBoliviaDay } from '../common/time/service-window';
import { localWeekdayAndMinute } from '../common/time/weekly-schedule';
import { QrPaymentsService } from '../bank-qr/qr-payments.service';
import { OperationalSettingsService } from '../operational-settings/operational-settings.service';
import { CreateReservationDto } from './dto/reservation.dto';
import {
  depositOutcomeOnCancel,
  fitsInDay,
  ReservationTimingSettings,
  slotsForDate,
} from './reservation-rules';

import { ReservationSettingsView, PublicReservationResponse, StaffReservationResponse, AvailabilityResponse } from './dto/tables-response.dto';
export { ReservationSettingsView, PublicReservationResponse, StaffReservationResponse, AvailabilityResponse };

/** Estados que bloquean una mesa en el calendario. */
const BLOCKING_STATUSES: ReservationStatus[] = ['pending_payment', 'confirmed', 'seated'];

type ReservationRow = {
  id: string;
  reservation_number: string;
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
      maxPeoplePerDay: row.max_people_per_day,
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
        ...(patch.maxPeoplePerDay !== undefined ? { max_people_per_day: patch.maxPeoplePerDay } : {}),
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

  /**
   * Horarios libres de un día para un grupo. El cupo es por PERSONAS del día (no por mesa): si el grupo cabe dentro del máximo
   * de personas con reserva, se ofrecen todos los horarios del día; si no, ninguno.
   */
  async availability(date: string, partySize: number): Promise<AvailabilityResponse> {
    const settings = await this.getSettings();
    const base = {
      date,
      partySize,
      maxPartySize: settings.maxPeoplePerDay,
      depositAmount: settings.depositAmount,
      paymentTtlMinutes: settings.paymentTtlMinutes,
    };
    if (!settings.enabled || partySize < 1 || partySize > settings.maxPeoplePerDay) return { ...base, slots: [] };

    const slots = await this.openSlots(date, settings);
    if (slots.length === 0) return { ...base, slots: [] };

    const reservedPeople = await this.reservedPeopleOnDay(this.db, date, new Date());
    if (!fitsInDay({ reservedPeople, partySize, maxPeoplePerDay: settings.maxPeoplePerDay })) {
      return { ...base, slots: [] };
    }
    return {
      ...base,
      slots: slots.map((startsAt) => ({ startsAt: startsAt.toISOString(), time: localTime(startsAt) })),
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

    // Serializa las reservas DEL MISMO DÍA: dos solicitudes a la vez no pueden pasarse del cupo juntas. El candado dura lo que
    // la transacción y es por fecha, así que reservar otro día no espera.
    const day = dateInBolivia(startsAt);
    await sql`select pg_advisory_xact_lock(hashtext(${'reservations:' + day}))`.execute(trx);

    if (dto.partySize > settings.maxPeoplePerDay) {
      throw new DomainException(
        'party_too_large',
        HttpStatus.CONFLICT,
        `Reservamos para hasta ${settings.maxPeoplePerDay} personas.`,
        { maxPartySize: settings.maxPeoplePerDay },
      );
    }
    const reservedPeople = await this.reservedPeopleOnDay(trx, day, now);
    if (!fitsInDay({ reservedPeople, partySize: dto.partySize, maxPeoplePerDay: settings.maxPeoplePerDay })) {
      throw new DomainException(
        'no_availability',
        HttpStatus.CONFLICT,
        'Ya no quedan lugares para ese día.',
        { startsAt: startsAt.toISOString(), partySize: dto.partySize },
      );
    }
    const blocksUntil = this.endOf(startsAt, settings);

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
      .selectAll('reservations')
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
    return rows.map(toStaff);
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

  /**
   * Personas con reserva viva ese día (hora de Bolivia): pendientes de pago que todavía no vencieron, confirmadas y ya
   * sentadas. Una pendiente que pasó su plazo no cuenta (la libera el proceso periódico).
   */
  private async reservedPeopleOnDay(db: Kysely<Database>, date: string, now: Date): Promise<number> {
    const from = startOfBoliviaDay(date);
    const to = new Date(from.getTime() + 24 * 60 * 60_000);
    const row = await db
      .selectFrom('reservations')
      .select(sql<string>`coalesce(sum(party_size), 0)`.as('people'))
      .where('status', 'in', BLOCKING_STATUSES)
      .where('starts_at', '>=', from)
      .where('starts_at', '<', to)
      .where((eb) =>
        eb.not(eb.and([eb('status', '=', 'pending_payment'), eb('expires_at', '<', now)])),
      )
      .executeTakeFirst();
    return Number(row?.people ?? 0);
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
      .selectAll('reservations')
      .where('reservations.id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundDomainError('reservation', id);
    return toStaff(row);
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

function toStaff(row: ReservationRow): StaffReservationResponse {
  return {
    ...toPublic(row),
    customerPhone: row.customer_phone,
    blocksUntil: new Date(row.blocks_until).toISOString(),
    accountOrderId: row.account_order_id,
    cancelReason: row.cancel_reason,
  };
}
