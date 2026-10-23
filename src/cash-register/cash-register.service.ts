import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Kysely, sql, Transaction } from 'kysely';
import { KYSELY } from '../database/database.module';
import { CashRegisterSessionStatus, Database } from '../database/types';
import { DomainException, NotFoundDomainError } from '../common/exceptions/domain-exception';
import { QR_CHARGE_AMOUNT_SQL } from '../payment-options/payment-options.rules';

import { CashRegisterSessionResponse } from './dto/cash-register-response.dto';
export { CashRegisterSessionResponse };

/**
 * Totales de la caja abierta calculados al vuelo, para que el POS muestre
 * cómo va el turno sin esperar al cierre. Los campos congelados de la fila
 * (`expectedCashAmount` y compañía) siguen en null hasta cerrar: estos son
 * el estado de este momento, no el número firmado del arqueo.
 */
export interface CashRegisterLiveTotals {
  totalCashSalesAmount: number;
  totalQrSalesAmount: number;
  totalSalesAmount: number;
  expectedCashAmount: number;
}

export type CurrentCashRegisterSessionResponse = CashRegisterSessionResponse & {
  liveTotals: CashRegisterLiveTotals;
};

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

/**
 * Caja (turno). Una sola sesión `status='open'` a la vez para todo el local
 * (índice único parcial en la migración) — cubre efectivo y QR por igual,
 * no solo plata física: agrupa cualquier pedido confirmado pagado durante
 * la sesión. El rango opened_at..closed_at ES el "día de negocio" (el local
 * cruza medianoche, así que no hay una fecha calendario que lo represente).
 */
@Injectable()
export class CashRegisterService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async open(openingAmount: number, openedBy: string): Promise<CashRegisterSessionResponse> {
    try {
      const row = await this.db
        .insertInto('cash_register_sessions')
        .values({ opening_amount: openingAmount.toFixed(2), opened_by: openedBy })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toResponse(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainException(
          'cash_register_already_open',
          HttpStatus.CONFLICT,
          'Ya hay una caja abierta.',
        );
      }
      throw error;
    }
  }

  async close(
    countedCashAmount: number,
    notes: string | undefined,
    closedBy: string,
  ): Promise<CashRegisterSessionResponse> {
    return this.db.transaction().execute(async (trx) => {
      const open = await trx
        .selectFrom('cash_register_sessions')
        .selectAll()
        .where('status', '=', 'open')
        .forUpdate()
        .executeTakeFirst();
      if (!open) {
        throw new DomainException(
          'cash_register_not_open',
          HttpStatus.CONFLICT,
          'No hay ninguna caja abierta para cerrar.',
        );
      }

      const { cash: totalCash, qr: totalQr } = await this.sumPaidSales(trx, open.id);
      const expectedCash = Number(open.opening_amount) + totalCash;
      const difference = countedCashAmount - expectedCash;

      const updated = await trx
        .updateTable('cash_register_sessions')
        .set({
          status: 'closed',
          closed_at: new Date(),
          closed_by: closedBy,
          counted_cash_amount: countedCashAmount.toFixed(2),
          expected_cash_amount: expectedCash.toFixed(2),
          cash_difference: difference.toFixed(2),
          total_cash_sales_amount: totalCash.toFixed(2),
          total_qr_sales_amount: totalQr.toFixed(2),
          total_sales_amount: (totalCash + totalQr).toFixed(2),
          notes: notes ?? null,
        })
        .where('id', '=', open.id)
        .returningAll()
        .executeTakeFirstOrThrow();

      return toResponse(updated);
    });
  }

  async getCurrent(): Promise<CurrentCashRegisterSessionResponse | null> {
    const row = await this.db
      .selectFrom('cash_register_sessions')
      .selectAll()
      .where('status', '=', 'open')
      .executeTakeFirst();
    if (!row) return null;

    const { cash, qr } = await this.sumPaidSales(this.db, row.id);
    return {
      ...toResponse(row),
      liveTotals: {
        totalCashSalesAmount: cash,
        totalQrSalesAmount: qr,
        totalSalesAmount: cash + qr,
        expectedCashAmount: Number(row.opening_amount) + cash,
      },
    };
  }

  /** Usado por el gate de horario (checkoutGateAt): si hay caja abierta, un pedido dentro del margen horario se confirma directo; si no, se encola. */
  async isOpen(): Promise<boolean> {
    const open = await this.db
      .selectFrom('cash_register_sessions')
      .select('id')
      .where('status', '=', 'open')
      .executeTakeFirst();
    return open !== undefined;
  }

  /**
   * Solo lo YA pagado: un pedido tardío se vincula a la caja al aceptarse
   * (antes de cobrarse), así que sin este filtro un cash todavía impago
   * contaría como plata ya en el cajón. Un pedido `split` reparte su
   * `total_amount` entre las dos patas (`split_cash_amount`/
   * `split_qr_amount`) en vez de contarlo entero en un solo bucket — si no,
   * el efectivo real en el cajón quedaría mal calculado cada vez que
   * alguien paga mitad y mitad. Un pedido QR cuenta lo que el QR realmente
   * cobró (ver `QR_CHARGE_AMOUNT_SQL`): el envío de un delivery `food_only`
   * lo cobra el repartidor en la calle y no entra al cuadre del banco.
   */
  private async sumPaidSales(
    db: Kysely<Database> | Transaction<Database>,
    sessionId: string,
  ): Promise<{ cash: number; qr: number }> {
    const result = await db
      .selectFrom('orders')
      .select([
        sql<string>`coalesce(sum(case
          when payment_method = 'cash' then total_amount
          when payment_method = 'split' then split_cash_amount
          else 0
        end), 0)`.as('cash_total'),
        sql<string>`coalesce(sum(case
          when payment_method = 'qr' then ${sql.raw(QR_CHARGE_AMOUNT_SQL)}
          when payment_method = 'split' then split_qr_amount
          else 0
        end), 0)`.as('qr_total'),
      ])
      .where('register_session_id', '=', sessionId)
      .where('payment_status', '=', 'paid')
      .executeTakeFirst();
    return {
      cash: Number(result?.cash_total ?? 0),
      qr: Number(result?.qr_total ?? 0),
    };
  }

  async getById(id: string): Promise<CashRegisterSessionResponse> {
    const row = await this.db
      .selectFrom('cash_register_sessions')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundDomainError('cash_register_session', id);
    return toResponse(row);
  }

  async findMany(limit?: number, offset?: number): Promise<CashRegisterSessionResponse[]> {
    const rows = await this.db
      .selectFrom('cash_register_sessions')
      .selectAll()
      .orderBy('opened_at', 'desc')
      .limit(Math.min(limit ?? 50, 200))
      .offset(offset ?? 0)
      .execute();
    return rows.map(toResponse);
  }

  /**
   * Usado por orders/payment-attempts/late-order-requests para vincular un
   * pedido a la caja en el momento exacto en que su pago se confirma (o, si
   * es un pedido fuera de horario, al aceptarlo). Acepta tanto la conexión
   * suelta como una transacción ajena, para poder llamarse dentro de la
   * transacción de quien pide el id.
   */
  /**
   * Caja a la que vincular un pago que se está confirmando. Con caja abierta,
   * esa; sin caja, depende de `require_open_register`: obligatoria (lo
   * habitual) → 409 cash_register_closed; opcional → null, el pago queda
   * sin caja y entra a los reportes por fecha. Nunca falla si el local no
   * usa caja.
   */
  async sessionIdForPayment(db: Kysely<Database> | Transaction<Database>): Promise<string | null> {
    const open = await db
      .selectFrom('cash_register_sessions')
      .select('id')
      .where('status', '=', 'open')
      .executeTakeFirst();
    if (open) return open.id;

    const settings = await db
      .selectFrom('operational_settings')
      .select('require_open_register')
      .where('id', '=', true)
      .executeTakeFirst();
    if (settings && settings.require_open_register === false) return null;
    return this.assertOpenSessionId(db); // lanza cash_register_closed
  }

  /**
   * Caja abierta si la hay, null si no. Para cobros que entran con el local
   * cerrado (el adelanto de una reserva que se paga desde la landing): la plata
   * es real, pero exigir caja abierta la dejaría trabada como "sin aplicar".
   */
  async openSessionIdOrNull(db: Kysely<Database> | Transaction<Database>): Promise<string | null> {
    const open = await db
      .selectFrom('cash_register_sessions')
      .select('id')
      .where('status', '=', 'open')
      .executeTakeFirst();
    return open?.id ?? null;
  }

  async assertOpenSessionId(db: Kysely<Database> | Transaction<Database>): Promise<string> {
    const open = await db
      .selectFrom('cash_register_sessions')
      .select('id')
      .where('status', '=', 'open')
      .executeTakeFirst();
    if (!open) {
      throw new DomainException(
        'cash_register_closed',
        HttpStatus.CONFLICT,
        'No hay una caja abierta. Abrí la caja antes de confirmar este pago.',
      );
    }
    return open.id;
  }
}

export function toResponse(row: {
  id: string;
  status: CashRegisterSessionStatus;
  opened_at: Date | string;
  opened_by: string;
  opening_amount: string;
  closed_at: Date | string | null;
  closed_by: string | null;
  counted_cash_amount: string | null;
  expected_cash_amount: string | null;
  cash_difference: string | null;
  total_cash_sales_amount: string | null;
  total_qr_sales_amount: string | null;
  total_sales_amount: string | null;
  notes: string | null;
}): CashRegisterSessionResponse {
  return {
    id: row.id,
    status: row.status,
    openedAt: new Date(row.opened_at).toISOString(),
    openedBy: row.opened_by,
    openingAmount: Number(row.opening_amount),
    closedAt: row.closed_at ? new Date(row.closed_at).toISOString() : null,
    closedBy: row.closed_by,
    countedCashAmount: row.counted_cash_amount === null ? null : Number(row.counted_cash_amount),
    expectedCashAmount: row.expected_cash_amount === null ? null : Number(row.expected_cash_amount),
    cashDifference: row.cash_difference === null ? null : Number(row.cash_difference),
    totalCashSalesAmount:
      row.total_cash_sales_amount === null ? null : Number(row.total_cash_sales_amount),
    totalQrSalesAmount: row.total_qr_sales_amount === null ? null : Number(row.total_qr_sales_amount),
    totalSalesAmount: row.total_sales_amount === null ? null : Number(row.total_sales_amount),
    notes: row.notes,
  };
}
