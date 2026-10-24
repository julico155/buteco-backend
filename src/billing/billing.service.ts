import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Kysely, sql } from 'kysely';
import { KYSELY } from '../database/database.module';
import { AppConfig } from '../config/configuration';
import { Database } from '../database/types';
import { DomainException, NotFoundDomainError, ValidationError } from '../common/exceptions/domain-exception';
import { dateInBolivia } from '../common/time/service-window';
import { withAmountCaption } from '../bank-qr/qr-image-caption';
import { NotificationsOutService } from '../notifications-out/notifications-out.service';
import { isBankConfigured } from '../payment-options/payment-options.rules';
import { agentBillingConfig, getAvailable } from './agent-billing';
import { BanecoTopupClientService } from './baneco-topup-client.service';
import { BillingSummaryResponse, LedgerEntryResponse, TopupResponse } from './dto/billing-response.dto';

/** El banco solo entiende fechas: el QR de recarga vive hasta el día siguiente. */
const TOPUP_DUE_DATE_MARGIN_DAYS = 1;
const POLL_BATCH = 20;

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly bank: BanecoTopupClientService,
    private readonly notifications: NotificationsOutService,
  ) {}

  /** Lo que muestra el POS: saldo, lo comprometido, si hay aviso de saldo bajo y si el agente está suspendido. */
  async getSummary(): Promise<BillingSummaryResponse> {
    const settings = this.config.get('agentBilling', { infer: true });
    const { balance, reserved, available } = await getAvailable(this.db);
    const enabled = agentBillingConfig(this.config) !== null;
    return {
      enabled,
      balance,
      reserved,
      available,
      commissionPercent: settings.commissionPercent,
      overdraftLimit: settings.overdraftLimit,
      lowBalanceThreshold: settings.lowBalanceThreshold,
      lowBalance: enabled && balance <= settings.lowBalanceThreshold,
      suspended: enabled && available <= -settings.overdraftLimit,
      topupMinAmount: settings.topupMinAmount,
      topupConfigured: this.topupConfigured(),
    };
  }

  async listLedger(limit = 50, offset = 0): Promise<LedgerEntryResponse[]> {
    const rows = await this.ledgerQuery()
      .orderBy('l.created_at', 'desc')
      .orderBy('l.id', 'desc')
      .limit(Math.min(Math.max(limit, 1), 200))
      .offset(Math.max(offset, 0))
      .execute();
    return rows.map(toLedgerEntry);
  }

  /** Ajuste manual del admin (corrección, bonificación, devolución a mano): queda en el libro con su motivo. */
  async createAdjustment(amount: number, note: string, username: string): Promise<LedgerEntryResponse> {
    if (amount === 0) throw new ValidationError('El ajuste no puede ser 0.');
    const inserted = await this.db
      .insertInto('balance_ledger')
      .values({ type: 'adjustment', amount: amount.toFixed(2), note: note.trim(), created_by: username })
      .returning('id')
      .executeTakeFirstOrThrow();
    const row = await this.ledgerQuery().where('l.id', '=', inserted.id).executeTakeFirstOrThrow();
    return toLedgerEntry(row);
  }

  /** Genera el QR de una recarga con las llaves del banco de recargas. */
  async createTopup(amount: number, username: string): Promise<TopupResponse> {
    const { topupMinAmount } = this.config.get('agentBilling', { infer: true });
    if (amount < topupMinAmount) {
      throw new DomainException(
        'topup_below_minimum',
        HttpStatus.BAD_REQUEST,
        `La recarga mínima es de Bs ${topupMinAmount.toFixed(2)}.`,
        { minimumAmount: topupMinAmount },
      );
    }
    if (!this.topupConfigured()) {
      throw new DomainException(
        'topup_not_configured',
        HttpStatus.CONFLICT,
        'Las recargas de saldo no están habilitadas todavía en este servidor.',
      );
    }

    const transactionId = `topup-${randomUUID()}`;
    const dueDate = dateInBolivia(new Date(Date.now() + TOPUP_DUE_DATE_MARGIN_DAYS * 24 * 60 * 60 * 1000));
    let generated;
    try {
      generated = await this.bank.generateQR({
        transactionId,
        amount,
        description: 'Recarga de saldo',
        dueDate,
      });
    } catch (error) {
      this.logger.error(`generateQR de recarga falló: ${(error as Error).message}`);
      throw new DomainException(
        'qr_generation_failed',
        HttpStatus.BAD_GATEWAY,
        'No se pudo generar el QR con el banco. Reintentá en un momento.',
      );
    }

    const row = await this.db
      .insertInto('balance_topups')
      .values({
        amount: amount.toFixed(2),
        qr_id: generated.qrId,
        transaction_id: transactionId,
        due_date: dueDate,
        qr_image_base64: generated.qrImageBase64,
        raw_generate_response: JSON.stringify(generated.raw),
        created_by: username,
      })
      .returning(['id', 'amount', 'status', sql<string>`due_date::text`.as('due_date'), 'created_at', 'paid_at'])
      .executeTakeFirstOrThrow();
    return toTopupResponse(row);
  }

  async getTopup(id: string): Promise<TopupResponse> {
    const row = await this.db
      .selectFrom('balance_topups')
      .select(['id', 'amount', 'status', sql<string>`due_date::text`.as('due_date'), 'created_at', 'paid_at'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundDomainError('balance_topup', id);
    return toTopupResponse(row);
  }

  /** El QR del banco trae un monto genérico: se le agrega abajo el monto y el concepto reales de la recarga. */
  async getTopupImage(id: string): Promise<{ bytes: Buffer; mimeType: string }> {
    const row = await this.db
      .selectFrom('balance_topups')
      .select(['qr_image_base64', 'amount'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundDomainError('balance_topup', id);
    try {
      const bytes = await withAmountCaption({
        qrImageBase64: row.qr_image_base64,
        amountBs: Number(row.amount),
        concept: 'Recarga de saldo',
      });
      return { bytes, mimeType: 'image/png' };
    } catch (error) {
      this.logger.warn(`No se pudo componer la leyenda del QR de recarga ${id}: ${(error as Error).message}`);
      return { bytes: Buffer.from(row.qr_image_base64, 'base64'), mimeType: 'image/png' };
    }
  }

  /**
   * Revisa contra el banco las recargas pendientes (cron): pagada -> entra al libro; anulada o vencida -> se cierra. Si el pago
   * ya se detectó, marcar la recarga y sumar el saldo ocurre en UNA transacción: nunca queda una sin la otra, y reintentarlo
   * (cron doble, reinicio) no suma dos veces.
   */
  async pollPendingTopups(): Promise<void> {
    if (!this.topupConfigured()) return;
    const pending = await this.db
      .selectFrom('balance_topups')
      .select(['id', 'qr_id', sql<string>`due_date::text`.as('due_date')])
      .where('status', '=', 'pending')
      .orderBy('created_at', 'asc')
      .limit(POLL_BATCH)
      .execute();

    for (const topup of pending) {
      try {
        await this.resolveTopup(topup);
      } catch (error) {
        this.logger.warn(`Recarga ${topup.id}: no se pudo revisar (${(error as Error).message})`);
      }
    }
  }

  private async resolveTopup(topup: { id: string; qr_id: string; due_date: string }): Promise<void> {
    const status = await this.bank.statusQR(topup.qr_id);

    if (status.statusQrCode === 1) {
      await this.db.transaction().execute(async (trx) => {
        const confirmed = await trx
          .updateTable('balance_topups')
          .set({
            status: 'confirmed',
            paid_at: new Date(),
            raw_status_response: JSON.stringify(status.raw),
            updated_at: new Date(),
          })
          .where('id', '=', topup.id)
          .where('status', '=', 'pending')
          .returning(['amount'])
          .executeTakeFirst();
        // Otra vuelta ya la confirmó: no se suma otra vez.
        if (!confirmed) return;
        await trx
          .insertInto('balance_ledger')
          .values({ type: 'topup', amount: confirmed.amount, topup_id: topup.id, note: 'Recarga de saldo por QR' })
          .onConflict((oc) => oc.columns(['topup_id', 'type']).doNothing())
          .execute();
      });
      this.logger.log(`Recarga ${topup.id} confirmada.`);
      return;
    }

    if (status.statusQrCode === 9) {
      await this.closeTopup(topup.id, 'cancelled', status.raw);
      return;
    }

    // Sigue pendiente: si ya pasó su día de vigencia, se anula del lado del banco y se cierra.
    if (topup.due_date < dateInBolivia(new Date())) {
      try {
        await this.bank.cancelQR(topup.qr_id);
      } catch (error) {
        this.logger.warn(`cancelQR de la recarga ${topup.id} falló: ${(error as Error).message}`);
      }
      await this.closeTopup(topup.id, 'expired', status.raw);
    }
  }

  private async closeTopup(id: string, status: 'cancelled' | 'expired', raw: unknown): Promise<void> {
    await this.db
      .updateTable('balance_topups')
      .set({ status, raw_status_response: JSON.stringify(raw), updated_at: new Date() })
      .where('id', '=', id)
      .where('status', '=', 'pending')
      .execute();
  }

  /**
   * Aviso al personal cuando el saldo baja del umbral. Una sola vez por bajada: el estado vive en la base (`billing_state`), así
   * que ni el cron cada pocos segundos ni un reinicio lo repiten, y se rearma solo cuando el saldo vuelve a estar por encima.
   */
  async checkLowBalance(): Promise<void> {
    const cfg = agentBillingConfig(this.config);
    if (!cfg) return;
    const { balance } = await getAvailable(this.db);

    if (balance > cfg.lowBalanceThreshold) {
      await this.db
        .updateTable('billing_state')
        .set({ low_balance_notified: false, updated_at: new Date() })
        .where('low_balance_notified', '=', true)
        .execute();
      return;
    }

    const claimed = await this.db
      .updateTable('billing_state')
      .set({ low_balance_notified: true, updated_at: new Date() })
      .where('low_balance_notified', '=', false)
      .returning('id')
      .executeTakeFirst();
    if (!claimed) return;

    try {
      await this.notifications.notifyNow({
        channel: 'telegram',
        kind: 'billing_low_balance',
        targetRef: `low-balance-${Date.now()}`,
        payload: {
          chatRef: 'staff-group',
          text:
            `Saldo bajo: Bs ${balance.toFixed(2)}. Recargá para que el agente siga tomando pedidos ` +
            `(se frena al pasar de -Bs ${cfg.overdraftLimit.toFixed(2)}).`,
        },
      });
    } catch (error) {
      this.logger.warn(`No se pudo avisar el saldo bajo: ${(error as Error).message}`);
    }
  }

  private topupConfigured(): boolean {
    return isBankConfigured(this.config.get('banecoTopup', { infer: true }));
  }

  private ledgerQuery() {
    return this.db
      .selectFrom('balance_ledger as l')
      .leftJoin('orders as o', 'o.id', 'l.order_id')
      .select(['l.id', 'l.type', 'l.amount', 'l.order_id', 'o.order_number', 'l.topup_id', 'l.note', 'l.created_by', 'l.created_at']);
  }
}

function toLedgerEntry(row: {
  id: string;
  type: LedgerEntryResponse['type'];
  amount: string;
  order_id: string | null;
  order_number: string | null;
  topup_id: string | null;
  note: string | null;
  created_by: string | null;
  created_at: Date | string;
}): LedgerEntryResponse {
  return {
    id: row.id,
    type: row.type,
    amount: Number(row.amount),
    orderId: row.order_id,
    orderNumber: row.order_number,
    topupId: row.topup_id,
    note: row.note,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function toTopupResponse(row: {
  id: string;
  amount: string;
  status: TopupResponse['status'];
  due_date: string;
  created_at: Date | string;
  paid_at: Date | string | null;
}): TopupResponse {
  return {
    id: row.id,
    amount: Number(row.amount),
    status: row.status,
    dueDate: row.due_date,
    qrImageUrl: `/billing/topups/${row.id}/qr-image`,
    createdAt: new Date(row.created_at).toISOString(),
    paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
  };
}
