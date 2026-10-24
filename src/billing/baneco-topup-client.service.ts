import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BanecoClientService } from '../baneco/baneco-client.service';
import { AppConfig, BanecoCredentials } from '../config/configuration';

/**
 * Mismo cliente HTTP del banco, con el SEGUNDO juego de llaves (`BANECO_TOPUP_*`): las recargas de saldo se cobran en la cuenta
 * de quien opera la plataforma, no en la del restaurante. Es otra instancia, así que su token cacheado nunca se mezcla con el
 * de los cobros de pedidos.
 */
@Injectable()
export class BanecoTopupClientService extends BanecoClientService {
  constructor(config: ConfigService<AppConfig, true>) {
    super(config);
  }

  protected override credentials(): BanecoCredentials {
    return this.config.get('banecoTopup', { infer: true });
  }
}
