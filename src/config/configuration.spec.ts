import configuration from './configuration';

describe('configuration', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalJwtSecret = process.env.JWT_SECRET;

  afterEach(() => {
    restoreEnv('DATABASE_URL', originalDatabaseUrl);
    restoreEnv('JWT_SECRET', originalJwtSecret);
  });

  it('accepts non-blank required configuration without exposing it', () => {
    process.env.DATABASE_URL = 'postgresql://configured-for-test';
    process.env.JWT_SECRET = 'configured-for-test';

    expect(configuration()).toMatchObject({
      databaseUrl: 'postgresql://configured-for-test',
      jwt: { secret: 'configured-for-test' },
    });
  });

  for (const name of ['DATABASE_URL', 'JWT_SECRET'] as const) {
    it(`rejects a missing or blank ${name}`, () => {
      process.env.DATABASE_URL = 'postgresql://configured-for-test';
      process.env.JWT_SECRET = 'configured-for-test';

      delete process.env[name];
      expect(() => configuration()).toThrow(`Missing required environment variable: ${name}`);

      process.env[name] = '   ';
      expect(() => configuration()).toThrow(`Missing required environment variable: ${name}`);
    });
  }

  describe('aiTestPhones', () => {
    const originalAiTestPhones = process.env.AI_TEST_PHONES;

    beforeEach(() => {
      process.env.DATABASE_URL = 'postgresql://configured-for-test';
      process.env.JWT_SECRET = 'configured-for-test';
    });

    afterEach(() => restoreEnv('AI_TEST_PHONES', originalAiTestPhones));

    it('is empty by default (unset = no behavior change)', () => {
      delete process.env.AI_TEST_PHONES;
      expect(configuration().aiTestPhones).toEqual([]);
    });

    it('parses and normalizes a comma-separated list', () => {
      // normalizePhone con assumeInternational solo agrega el '+' — no inventa
      // código de país — así que los 3 formatos de entrada deben traerlo ya.
      process.env.AI_TEST_PHONES = ' +591 700-00001 , 59170000002, +59170000003 ';
      expect(configuration().aiTestPhones).toEqual(['+59170000001', '+59170000002', '+59170000003']);
    });
  });

  describe('lateOrderRequestTtlMinutes / deliveryNoticeChatRef', () => {
    const names = [
      'LATE_ORDER_REQUEST_TTL_MINUTES',
      'UNPAID_ORDER_TTL_MINUTES',
      'DELIVERY_NOTICE_CHAT_REF',
    ] as const;
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      process.env.DATABASE_URL = 'postgresql://configured-for-test';
      process.env.JWT_SECRET = 'configured-for-test';
      for (const name of names) {
        saved[name] = process.env[name];
        delete process.env[name];
      }
    });

    afterEach(() => {
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    });

    it('TTL de solicitud fuera de horario: 20 por defecto', () => {
      expect(configuration().lateOrderRequestTtlMinutes).toBe(20);
    });

    it('sin variable propia sigue al TTL de pedidos sin pagar', () => {
      process.env.UNPAID_ORDER_TTL_MINUTES = '35';
      expect(configuration().lateOrderRequestTtlMinutes).toBe(35);
    });

    it('la variable propia manda sobre el TTL de pedidos sin pagar', () => {
      process.env.UNPAID_ORDER_TTL_MINUTES = '35';
      process.env.LATE_ORDER_REQUEST_TTL_MINUTES = '10';
      expect(configuration().lateOrderRequestTtlMinutes).toBe(10);
    });

    it('destino del aviso de delivery: "delivery-group" por defecto y configurable', () => {
      expect(configuration().deliveryNoticeChatRef).toBe('delivery-group');
      process.env.DELIVERY_NOTICE_CHAT_REF = '  grupo-repartidores ';
      expect(configuration().deliveryNoticeChatRef).toBe('grupo-repartidores');
    });
  });

  describe('storage S3', () => {
    const suffixes = ['BUCKET', 'REGION', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'ENDPOINT'];
    const names = suffixes.flatMap((n) => [`STORAGE_S3_${n}`, `PAYMENT_PROOFS_S3_${n}`]);
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      process.env.DATABASE_URL = 'postgresql://configured-for-test';
      process.env.JWT_SECRET = 'configured-for-test';
      for (const name of names) {
        saved[name] = process.env[name];
        delete process.env[name];
      }
    });

    afterEach(() => {
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    });

    it('sin variables: sin bucket y región auto', () => {
      expect(configuration().s3).toMatchObject({ bucket: '', region: 'auto', endpoint: '' });
    });

    it('lee STORAGE_S3_*', () => {
      process.env.STORAGE_S3_BUCKET = 'media';
      process.env.STORAGE_S3_REGION = 'us-east-1';
      expect(configuration().s3).toMatchObject({ bucket: 'media', region: 'us-east-1' });
    });

    it('acepta los nombres anteriores PAYMENT_PROOFS_S3_* si no hay STORAGE_S3_*', () => {
      process.env.PAYMENT_PROOFS_S3_BUCKET = 'legacy-bucket';
      process.env.PAYMENT_PROOFS_S3_ACCESS_KEY_ID = 'legacy-key';
      expect(configuration().s3).toMatchObject({ bucket: 'legacy-bucket', accessKeyId: 'legacy-key' });
    });

    it('STORAGE_S3_* manda sobre PAYMENT_PROOFS_S3_*', () => {
      process.env.STORAGE_S3_BUCKET = 'new';
      process.env.PAYMENT_PROOFS_S3_BUCKET = 'old';
      expect(configuration().s3.bucket).toBe('new');
    });
  });

  describe('bootstrapAdmin', () => {
    const names = ['BOOTSTRAP_ADMIN_USERNAME', 'BOOTSTRAP_ADMIN_PASSWORD'] as const;
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      process.env.DATABASE_URL = 'postgresql://configured-for-test';
      process.env.JWT_SECRET = 'configured-for-test';
      for (const name of names) {
        saved[name] = process.env[name];
        delete process.env[name];
      }
    });

    afterEach(() => {
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    });

    it('por defecto no hay contraseña (no crea nada) y el usuario es admin', () => {
      expect(configuration().bootstrapAdmin).toEqual({ username: 'admin', password: '' });
    });

    it('lee usuario y contraseña del entorno', () => {
      process.env.BOOTSTRAP_ADMIN_USERNAME = ' duenio ';
      process.env.BOOTSTRAP_ADMIN_PASSWORD = 'una-clave-larga';
      expect(configuration().bootstrapAdmin).toEqual({ username: 'duenio', password: 'una-clave-larga' });
    });
  });
});

function restoreEnv(name: 'DATABASE_URL' | 'JWT_SECRET' | 'AI_TEST_PHONES', value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
