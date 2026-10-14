import 'dotenv/config';
import * as bcrypt from 'bcryptjs';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { Database, DashboardUserRole } from '../src/database/types';

// Arranque en frío: POST /auth/users exige un admin ya logueado, así que el
// primer usuario solo puede crearse fuera de la API.

const BCRYPT_ROUNDS = 10;
const ROLES: DashboardUserRole[] = ['admin', 'kitchen', 'cashier'];

const USAGE = `
Uso: npm run create-admin -- <username> [role]

La contraseña se lee de ADMIN_PASSWORD, o del tercer argumento si no está
(pasarla por argumento la deja en el historial del shell).

  PowerShell:  $env:ADMIN_PASSWORD='...'; npm run create-admin -- admin admin
  bash:        ADMIN_PASSWORD='...' npm run create-admin -- admin admin

role por defecto: admin. Valores: ${ROLES.join(', ')}.
`.trim();

async function main(): Promise<void> {
  const username = process.argv[2];
  const password = process.env.ADMIN_PASSWORD ?? process.argv[3];
  const role = (process.argv[4] ?? 'admin') as DashboardUserRole;

  if (!username || !password) {
    throw new Error(USAGE);
  }
  if (!ROLES.includes(role)) {
    throw new Error(`Rol inválido: "${role}". Valores: ${ROLES.join(', ')}.`);
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('Falta DATABASE_URL (definila en .env o en el entorno).');
  }

  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.DATABASE_URL }) }),
  });

  try {
    const existing = await db
      .selectFrom('dashboard_users')
      .select('id')
      .where('username', '=', username)
      .executeTakeFirst();
    if (existing) {
      throw new Error(`El usuario "${username}" ya existe. Para crear más staff usá POST /auth/users.`);
    }

    const created = await db
      .insertInto('dashboard_users')
      .values({
        username,
        password_hash: await bcrypt.hash(password, BCRYPT_ROUNDS),
        role,
      })
      .returning(['id', 'username', 'role'])
      .executeTakeFirstOrThrow();

    console.log(`Creado: ${created.username} (${created.role}) — id ${created.id}`);
  } finally {
    await db.destroy();
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
