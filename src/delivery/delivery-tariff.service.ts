import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Kysely, Transaction } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';
import { DomainException } from '../common/exceptions/domain-exception';
import { TariffBandInput, validateTariffBands } from './delivery-bands.rules';

export interface TariffBandResponse {
  bandIndex: number;
  maxDistanceMeters: number;
  feeAmount: number;
}

export type DeliveryFee =
  /** `free`: gratuidad por política (modo free o gratis sobre un monto) — exime también el recargo por lluvia. */
  | { ok: true; amount: number; bandIndex: number | null; free?: boolean }
  | { ok: false; reason: 'manual_quote' | 'invalid_distance' };

/**
 * Bandas de tarifa: fuente única en `delivery_tariff_bands`, que carga el seed
 * de cada restaurante. Cada banda tiene su propio `max_distance_meters`; una
 * distancia cae en la primera banda (por `band_index` ascendente) cuyo máximo la
 * alcanza, o sea que la banda k cubre (máximo de la k-1, máximo de la k]. Hace
 * falta que `band_index` y `max_distance_meters` crezcan juntos: la tabla no lo
 * valida.
 */
@Injectable()
export class DeliveryTariffService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async getBands(executor: Kysely<Database> | Transaction<Database> = this.db) {
    const bands = await executor
      .selectFrom('delivery_tariff_bands')
      .selectAll()
      .orderBy('band_index', 'asc')
      .execute();

    if (bands.length === 0) {
      throw new DomainException(
        'delivery_tariff_not_configured',
        HttpStatus.INTERNAL_SERVER_ERROR,
        'No hay bandas de tarifa de delivery configuradas.',
      );
    }
    return bands;
  }

  /** Las bandas tal como están, sin lanzar si no hay ninguna (para el admin). */
  async listBands(executor: Kysely<Database> | Transaction<Database> = this.db): Promise<TariffBandResponse[]> {
    const rows = await executor
      .selectFrom('delivery_tariff_bands')
      .selectAll()
      .orderBy('band_index', 'asc')
      .execute();
    return rows.map((row) => ({
      bandIndex: row.band_index,
      maxDistanceMeters: row.max_distance_meters,
      feeAmount: Number(row.fee_amount),
    }));
  }

  /**
   * Reemplaza la tabla completa en una transacción: nunca queda a medias, y
   * `band_index` sale de la posición (1..n), así no hay huecos ni repetidos.
   */
  async replaceBands(bands: TariffBandInput[]): Promise<TariffBandResponse[]> {
    validateTariffBands(bands);
    return this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('delivery_tariff_bands').execute();
      await trx
        .insertInto('delivery_tariff_bands')
        .values(
          bands.map((band, index) => ({
            band_index: index + 1,
            max_distance_meters: band.maxDistanceMeters,
            fee_amount: band.feeAmount.toFixed(2),
          })),
        )
        .execute();
      return this.listBands(trx);
    });
  }

  /** Techo automático: distancia máxima cubierta por la última banda. */
  async maxAutomaticMeters(
    executor: Kysely<Database> | Transaction<Database> = this.db,
  ): Promise<number> {
    const bands = await this.getBands(executor);
    return bands[bands.length - 1].max_distance_meters;
  }

  async feeForMeters(
    meters: number,
    executor: Kysely<Database> | Transaction<Database> = this.db,
  ): Promise<DeliveryFee> {
    if (!Number.isFinite(meters) || meters < 0) {
      return { ok: false, reason: 'invalid_distance' };
    }

    const bands = await this.getBands(executor);
    const maxMeters = bands[bands.length - 1].max_distance_meters;
    if (meters > maxMeters) {
      return { ok: false, reason: 'manual_quote' };
    }

    const band = bands.find((b) => meters <= b.max_distance_meters);
    if (!band) {
      return { ok: false, reason: 'invalid_distance' };
    }
    return { ok: true, amount: Number(band.fee_amount), bandIndex: band.band_index };
  }
}
