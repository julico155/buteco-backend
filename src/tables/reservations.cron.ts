import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ReservationsService } from './reservations.service';

/** Confirma adelantos pagados, libera los que no se pagaron y marca los que no se presentaron. */
@Injectable()
export class ReservationsCron {
  private readonly logger = new Logger(ReservationsCron.name);
  private isRunning = false;

  constructor(private readonly reservations: ReservationsService) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async run(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const confirmed = await this.reservations.syncPayments();
      const expired = await this.reservations.expirePendingPayments();
      const noShows = await this.reservations.markNoShows();
      if (confirmed + expired + noShows > 0) {
        this.logger.log(
          `Reservas: ${confirmed} confirmadas, ${expired} vencidas sin pago, ${noShows} sin presentarse.`,
        );
      }
    } catch (error) {
      this.logger.error(`Proceso de reservas falló: ${(error as Error).message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
