import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely, Transaction } from 'kysely';
import { AppConfig } from '../config/configuration';
import { KYSELY } from '../database/database.module';
import { OperationalSettingsService } from '../operational-settings/operational-settings.service';
import { serviceAvailability } from '../operational-settings/availability.rules';
import {
  Database,
  OrderChannel,
  OrderDeliveryType,
  OrderPaymentMethod,
  PaymentOptionQrScope,
  QrScope,
} from '../database/types';
import { ValidationError } from '../common/exceptions/domain-exception';
import {
  assertBankReadyForQr,
  assertEveryServiceHasAnOption,
  bankAllows,
  BankContext,
  isBankConfigured,
  PaymentOptionRow,
  resolvePaymentOption,
} from './payment-options.rules';

export interface PaymentOptionResponse {
  serviceType: OrderDeliveryType;
  paymentMethod: OrderPaymentMethod;
  /** Solo delivery pagado por QR; null en el resto. */
  qrScope: QrScope | null;
  /** Lo que prendió el admin. */
  enabled: boolean;
  /** Canales de origen que pueden usar esta forma de pago. */
  channels: OrderChannel[];
  /**
   * Lo que el frontend debería ofrecer: prendida, permitida para el canal de
   * quien consulta y con el banco listo si hace falta. Pintar solo las
   * `available`.
   */
  available: boolean;
}

export interface PaymentOptionChange {
  serviceType: OrderDeliveryType;
  paymentMethod: OrderPaymentMethod;
  qrScope?: QrScope | null;
  /** Al menos uno de `enabled` / `channels` tiene que venir. */
  enabled?: boolean;
  channels?: OrderChannel[];
}

type Executor = Kysely<Database> | Transaction<Database>;

/**
 * Qué formas de pago acepta el local, por tipo de servicio. El admin solo
 * prende/apaga filas que ya existen; el catálogo de combinaciones posibles
 * lo fija el esquema (ver migración payment_options).
 */
@Injectable()
export class PaymentOptionsService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly operationalSettings: OperationalSettingsService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /** `channel`: canal de quien consulta (sale de su credencial) para calcular `available`. */
  async list(channel?: OrderChannel): Promise<PaymentOptionResponse[]> {
    const rows = await this.loadRows(this.db);
    return rows.map((row) => toResponse(row, channel, this.bankContext()));
  }

  private bankContext(): BankContext {
    return {
      bankConfigured: isBankConfigured(this.config.get('baneco', { infer: true })),
      posQrMode: this.config.get('posQrMode', { infer: true }),
    };
  }

  /**
   * Valida que el pedido pueda pagarse así y devuelve el `qr_scope` a
   * guardar. Acepta la transacción del checkout para leer en la misma
   * conexión; sin ella lee de la conexión suelta.
   */
  async resolve(
    choice: {
      serviceType: OrderDeliveryType;
      paymentMethod: OrderPaymentMethod;
      qrScope?: QrScope | null;
      channel?: OrderChannel;
    },
    executor: Executor = this.db,
  ): Promise<QrScope | null> {
    return resolvePaymentOption(await this.loadRows(executor), choice, this.bankContext());
  }

  async update(
    changes: PaymentOptionChange[],
    updatedBy: string,
    channel?: OrderChannel,
  ): Promise<PaymentOptionResponse[]> {
    if (changes.length === 0) throw new ValidationError('No hay cambios para aplicar.');
    for (const change of changes) {
      if (change.enabled === undefined && change.channels === undefined) {
        throw new ValidationError('Cada cambio necesita `enabled` o `channels`.', {
          serviceType: change.serviceType,
          paymentMethod: change.paymentMethod,
          qrScope: change.qrScope ?? null,
        });
      }
      if (change.channels !== undefined && change.channels.length === 0) {
        throw new ValidationError('`channels` necesita al menos un canal.', {
          serviceType: change.serviceType,
          paymentMethod: change.paymentMethod,
        });
      }
    }

    const settings = await this.operationalSettings.getRow();

    return this.db.transaction().execute(async (trx) => {
      const before = await this.loadRows(trx);
      assertBankReadyForQr({
        turningOn: before.filter((row) =>
          changes.some(
            (c) =>
              c.enabled === true &&
              !row.enabled &&
              c.serviceType === row.service_type &&
              c.paymentMethod === row.payment_method &&
              (c.qrScope ?? 'none') === row.qr_scope,
          ),
        ),
        bankConfigured: isBankConfigured(this.config.get('baneco', { infer: true })),
        posQrMode: this.config.get('posQrMode', { infer: true }),
      });

      for (const change of changes) {
        const scope: PaymentOptionQrScope = change.qrScope ?? 'none';
        const updated = await trx
          .updateTable('payment_options')
          .set({
            ...(change.enabled !== undefined ? { enabled: change.enabled } : {}),
            ...(change.channels !== undefined ? { channels: [...new Set(change.channels)] } : {}),
            updated_by: updatedBy,
            updated_at: new Date(),
          })
          .where('service_type', '=', change.serviceType)
          .where('payment_method', '=', change.paymentMethod)
          .where('qr_scope', '=', scope)
          .returning('service_type')
          .executeTakeFirst();
        if (!updated) {
          throw new ValidationError('Esa combinación de pago no existe.', {
            serviceType: change.serviceType,
            paymentMethod: change.paymentMethod,
            qrScope: change.qrScope ?? null,
          });
        }
      }

      const rows = await this.loadRows(trx);
      // Se valida sobre el estado resultante: si falla, el rollback deja todo
      // como estaba.
      // Un servicio apagado no necesita forma de pago (no vende).
      const sellable = (Object.entries(serviceAvailability(settings)) as [OrderDeliveryType, boolean][])
        .filter(([, enabled]) => enabled)
        .map(([type]) => type);
      assertEveryServiceHasAnOption(rows, sellable);
      const bank = this.bankContext();
      return rows.map((row) => toResponse(row, channel, bank));
    });
  }

  private async loadRows(executor: Executor): Promise<PaymentOptionRow[]> {
    return executor
      .selectFrom('payment_options')
      .select(['service_type', 'payment_method', 'qr_scope', 'enabled', 'channels'])
      .orderBy('service_type')
      .orderBy('payment_method')
      .orderBy('qr_scope')
      .execute();
  }
}

function toResponse(
  row: PaymentOptionRow,
  channel: OrderChannel | undefined,
  bank: BankContext,
): PaymentOptionResponse {
  const channelOk = channel === undefined || row.channels.includes(channel);
  return {
    serviceType: row.service_type,
    paymentMethod: row.payment_method,
    qrScope: row.qr_scope === 'none' ? null : row.qr_scope,
    enabled: row.enabled,
    channels: row.channels,
    available:
      row.enabled &&
      channelOk &&
      bankAllows({
        paymentMethod: row.payment_method,
        serviceType: row.service_type,
        channel,
        bank,
      }),
  };
}
