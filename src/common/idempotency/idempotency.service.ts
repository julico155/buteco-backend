import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Kysely, Transaction } from 'kysely';
import { KYSELY } from '../../database/database.module';
import { Database } from '../../database/types';
import { DomainException, IdempotencyKeyReusedError } from '../exceptions/domain-exception';

export interface IdempotentExecutionResult<T> {
  status: number;
  body: T;
}

export interface IdempotencyOutcome<T> {
  body: T;
  status: number;
  /** false si esta llamada devolvió una respuesta ya guardada de un intento anterior. */
  created: boolean;
}

/**
 * Mecanismo genérico de `Idempotency-Key` (reemplaza el fingerprint atado a
 * menu_sessions del diseño anterior — invariante 2 del plan). Mismo header +
 * mismo cuerpo -> misma respuesta guardada; mismo header + cuerpo distinto ->
 * 409 idempotency_key_reused.
 */
@Injectable()
export class IdempotencyService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async run<T>(params: {
    apiClient: string;
    endpoint: string;
    idempotencyKey: string;
    requestBody: unknown;
    execute: (trx: Transaction<Database>) => Promise<IdempotentExecutionResult<T>>;
  }): Promise<IdempotencyOutcome<T>> {
    const requestHash = hashRequestBody(params.requestBody);

    return this.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto('idempotency_keys')
        .values({
          api_client: params.apiClient,
          endpoint: params.endpoint,
          idempotency_key: params.idempotencyKey,
          request_hash: requestHash,
        })
        .onConflict((oc) => oc.columns(['api_client', 'endpoint', 'idempotency_key']).doNothing())
        .returningAll()
        .executeTakeFirst();

      if (!inserted) {
        const existing = await trx
          .selectFrom('idempotency_keys')
          .selectAll()
          .where('api_client', '=', params.apiClient)
          .where('endpoint', '=', params.endpoint)
          .where('idempotency_key', '=', params.idempotencyKey)
          .forUpdate()
          .executeTakeFirstOrThrow();

        if (existing.request_hash !== requestHash) {
          throw new IdempotencyKeyReusedError(params.idempotencyKey);
        }
        if (existing.completed_at) {
          return {
            body: existing.response_body as T,
            status: existing.response_status ?? HttpStatus.OK,
            created: false,
          };
        }
        throw new DomainException(
          'idempotency_in_progress',
          HttpStatus.CONFLICT,
          `Ya hay una operación en curso con la Idempotency-Key ${params.idempotencyKey}.`,
        );
      }

      const result = await params.execute(trx);

      await trx
        .updateTable('idempotency_keys')
        .set({
          response_status: result.status,
          response_body: JSON.stringify(result.body),
          completed_at: new Date(),
        })
        .where('id', '=', inserted.id)
        .execute();

      return { body: result.body, status: result.status, created: true };
    });
  }
}

export function hashRequestBody(body: unknown): string {
  return createHash('sha256').update(canonicalize(body)).digest('hex');
}

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`,
  );
  return `{${entries.join(',')}}`;
}
