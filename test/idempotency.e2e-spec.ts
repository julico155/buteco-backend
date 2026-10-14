import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { IdempotencyService } from '../src/common/idempotency/idempotency.service';
import { IdempotencyKeyReusedError } from '../src/common/exceptions/domain-exception';
import { Database } from '../src/database/types';
import { createTestDb, describeIfDb } from './utils/test-db';

/**
 * Invariante 2 del plan: mismo header Idempotency-Key + mismo cuerpo ->
 * misma respuesta guardada (created:false la segunda vez); mismo header +
 * cuerpo distinto -> 409 idempotency_key_reused.
 *
 * Requiere Postgres real con migraciones aplicadas:
 *   DATABASE_URL=... npm run migrate:up
 *   DATABASE_URL=... npm run test:e2e
 */
describeIfDb('IdempotencyService (integración)', () => {
  let db: Kysely<Database>;
  let service: IdempotencyService;

  beforeAll(() => {
    db = createTestDb();
    service = new IdempotencyService(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  afterEach(async () => {
    await db.deleteFrom('idempotency_keys').where('api_client', '=', 'test-suite').execute();
  });

  it('mismo body dos veces -> la segunda llamada no re-ejecuta y created es false', async () => {
    const key = randomUUID();
    const body = { items: [{ productId: 'p1', quantity: 1 }] };
    let executions = 0;

    const run = () =>
      service.run({
        apiClient: 'test-suite',
        endpoint: 'POST /orders',
        idempotencyKey: key,
        requestBody: body,
        execute: async () => {
          executions += 1;
          return { status: 201, body: { orderId: 'order-1', created: true } };
        },
      });

    const first = await run();
    const second = await run();

    expect(executions).toBe(1);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.body).toEqual(first.body);
  });

  it('mismo key con body distinto -> 409 idempotency_key_reused, nunca re-ejecuta', async () => {
    const key = randomUUID();
    let executions = 0;
    const execute = async () => {
      executions += 1;
      return { status: 201, body: { ok: true } };
    };

    await service.run({
      apiClient: 'test-suite',
      endpoint: 'POST /orders',
      idempotencyKey: key,
      requestBody: { items: [{ productId: 'p1', quantity: 1 }] },
      execute,
    });

    await expect(
      service.run({
        apiClient: 'test-suite',
        endpoint: 'POST /orders',
        idempotencyKey: key,
        requestBody: { items: [{ productId: 'p1', quantity: 2 }] },
        execute,
      }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);

    expect(executions).toBe(1);
  });

  it('dos requests concurrentes con la misma key nueva -> solo una ejecuta el efecto', async () => {
    const key = randomUUID();
    const body = { items: [{ productId: 'p1', quantity: 1 }] };
    let executions = 0;

    const run = () =>
      service.run({
        apiClient: 'test-suite',
        endpoint: 'POST /orders',
        idempotencyKey: key,
        requestBody: body,
        execute: async () => {
          executions += 1;
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { status: 201, body: { orderId: 'order-concurrent' } };
        },
      });

    const results = await Promise.allSettled([run(), run()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');

    // La segunda, si la transacción de la primera aún no commiteó, puede
    // recibir 'idempotency_in_progress' en vez de la respuesta final — lo
    // que nunca puede pasar es que el efecto se ejecute dos veces.
    expect(executions).toBe(1);
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
  });
});
