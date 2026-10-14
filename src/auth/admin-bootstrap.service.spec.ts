import * as bcrypt from 'bcryptjs';
import { AdminBootstrapService } from './admin-bootstrap.service';

function createService(options: {
  password?: string;
  username?: string;
  existingAdmin?: boolean;
  insertConflicts?: boolean;
  selectFails?: boolean;
}) {
  const inserted: Record<string, unknown>[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const selectChain: Record<string, any> = {
    select: jest.fn(() => selectChain),
    where: jest.fn(() => selectChain),
    limit: jest.fn(() => selectChain),
    executeTakeFirst: jest.fn(async () => {
      if (options.selectFails) throw new Error('relation "dashboard_users" does not exist');
      return options.existingAdmin ? { id: 'admin-1' } : undefined;
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const insertChain: Record<string, any> = {
    values: jest.fn((row: Record<string, unknown>) => {
      inserted.push(row);
      return insertChain;
    }),
    onConflict: jest.fn(() => insertChain),
    returning: jest.fn(() => insertChain),
    executeTakeFirst: jest.fn(async () => (options.insertConflicts ? undefined : { id: 'new-1' })),
  };
  const db = {
    selectFrom: jest.fn(() => selectChain),
    insertInto: jest.fn(() => insertChain),
  };
  const config = {
    get: jest.fn(() => ({
      username: options.username ?? 'admin',
      password: options.password ?? '',
    })),
  };
  return { service: new AdminBootstrapService(db as never, config as never), db, inserted };
}

describe('AdminBootstrapService', () => {
  it('sin BOOTSTRAP_ADMIN_PASSWORD no toca la base', async () => {
    const { service, db } = createService({ password: '' });

    await service.onApplicationBootstrap();

    expect(db.selectFrom).not.toHaveBeenCalled();
    expect(db.insertInto).not.toHaveBeenCalled();
  });

  it('crea el admin con la contraseña hasheada cuando no hay ninguno', async () => {
    const { service, inserted } = createService({ password: 'una-clave-larga', username: 'duenio' });

    await service.onApplicationBootstrap();

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ username: 'duenio', role: 'admin' });
    expect(inserted[0].password_hash).not.toBe('una-clave-larga');
    await expect(bcrypt.compare('una-clave-larga', inserted[0].password_hash as string)).resolves.toBe(true);
  });

  it('es idempotente: con un admin existente no crea nada aunque la variable siga puesta', async () => {
    const { service, db } = createService({ password: 'una-clave-larga', existingAdmin: true });

    await service.onApplicationBootstrap();

    expect(db.insertInto).not.toHaveBeenCalled();
  });

  it('rechaza una contraseña de menos de 8 caracteres sin tocar la base', async () => {
    const { service, db } = createService({ password: 'corta' });

    await expect(service.ensureAdmin('admin', 'corta')).resolves.toBe(false);
    expect(db.selectFrom).not.toHaveBeenCalled();
  });

  it('si otra instancia lo creó a la vez (conflicto de username) devuelve false', async () => {
    const { service } = createService({ password: 'una-clave-larga', insertConflicts: true });

    await expect(service.ensureAdmin('admin', 'una-clave-larga')).resolves.toBe(false);
  });

  it('un error de base de datos no tumba el arranque', async () => {
    const { service } = createService({ password: 'una-clave-larga', selectFails: true });

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
