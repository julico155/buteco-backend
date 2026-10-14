import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { Kysely } from 'kysely';
import { AppConfig } from '../config/configuration';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';

const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD_LENGTH = 8;

/**
 * Primer admin sin acceso a la base ni a una terminal: si BOOTSTRAP_ADMIN_PASSWORD
 * está definida y todavía no hay ningún admin, lo crea al arrancar. Es
 * idempotente (con un admin existente no hace nada, aunque la variable siga
 * puesta) y nunca tumba la app: ante cualquier error solo lo registra.
 *
 * `POST /auth/users` exige un admin ya logueado y `npm run create-admin`
 * necesita una terminal; esto cubre el despliegue automático. Una vez creado,
 * conviene quitar BOOTSTRAP_ADMIN_PASSWORD del entorno.
 */
@Injectable()
export class AdminBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdminBootstrapService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const { username, password } = this.config.get('bootstrapAdmin', { infer: true });
    if (!password) return;

    try {
      const created = await this.ensureAdmin(username, password);
      if (created) {
        this.logger.log(
          `Admin inicial "${username}" creado. Quitá BOOTSTRAP_ADMIN_PASSWORD del entorno.`,
        );
      }
    } catch (error) {
      this.logger.error(`No se pudo crear el admin inicial: ${(error as Error).message}`);
    }
  }

  /** Devuelve true solo si creó el usuario. */
  async ensureAdmin(username: string, password: string): Promise<boolean> {
    if (password.length < MIN_PASSWORD_LENGTH) {
      this.logger.warn(
        `BOOTSTRAP_ADMIN_PASSWORD tiene menos de ${MIN_PASSWORD_LENGTH} caracteres: no se crea el admin inicial.`,
      );
      return false;
    }

    const existingAdmin = await this.db
      .selectFrom('dashboard_users')
      .select('id')
      .where('role', '=', 'admin')
      .limit(1)
      .executeTakeFirst();
    if (existingAdmin) return false;

    // onConflict: dos instancias arrancando a la vez no se pisan.
    const created = await this.db
      .insertInto('dashboard_users')
      .values({
        username,
        password_hash: await bcrypt.hash(password, BCRYPT_ROUNDS),
        role: 'admin',
      })
      .onConflict((oc) => oc.column('username').doNothing())
      .returning('id')
      .executeTakeFirst();

    return created !== undefined;
  }
}
