import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { ServiceOrStaffAuthGuard } from '../common/guards/service-or-staff-auth.guard';
import { QrPaymentsService } from './qr-payments.service';
import { extractQrId } from './notify-payment';
import { MarkRefundedDto } from './dto/mark-refunded.dto';

@Controller()
export class BankQrController {
  private readonly logger = new Logger(BankQrController.name);

  constructor(private readonly qrPayments: QrPaymentsService) {}

  // El cajero lo dispara desde el POS al elegir "cobrar QR" — acción
  // explícita, no automática, así no se genera un QR bancario si el cliente
  // termina pagando efectivo.
  @Post('orders/:id/qr/generate')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'cashier')
  generate(@Param('id', ParseUUIDPipe) id: string) {
    return this.qrPayments.generateForOrder(id);
  }

  /**
   * Pagos que el banco cobró pero que ninguna caja recibió (entraron con la
   * caja cerrada). La plata está en la cuenta y el pedido sigue impago:
   * alguien tiene que decidir si se aplica o se le devuelve al cliente.
   */
  @Get('bank-qr/unapplied-payments')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'cashier')
  findUnapplied() {
    return this.qrPayments.findUnappliedPayments();
  }

  /** El local sigue abierto: se aplica el pago al pedido (exige caja abierta, como cualquier cobro). */
  @Post('bank-qr/unapplied-payments/:id/apply')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'cashier')
  @HttpCode(204)
  applyUnapplied(@Param('id', ParseUUIDPipe) id: string) {
    return this.qrPayments.applyUnappliedPayment(id);
  }

  /** Ya se le devolvió la plata al cliente por fuera — el banco no tiene API de devolución. */
  @Post('bank-qr/unapplied-payments/:id/refunded')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @HttpCode(204)
  markRefunded(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MarkRefundedDto) {
    return this.qrPayments.markRefunded(id, dto.notes);
  }

  /** Streaming autenticado — mismo criterio que fotos de producto, nunca Base64 crudo en un JSON. */
  @Get('orders/:id/qr-image')
  @UseGuards(ServiceOrStaffAuthGuard)
  async getImage(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { bytes, mimeType } = await this.qrPayments.getQrImage(id);
    res.setHeader('content-type', mimeType);
    res.setHeader('cache-control', 'private, max-age=60');
    res.send(bytes);
  }

  /**
   * `notifyPaymentQR` — el servicio que el comercio publica para que el banco
   * avise al momento del pago (manual Baneco v1.0.0, sección 6.5). La ruta
   * replica exactamente la del manual (`/api/qrsimple/notifyPaymentQR`), que
   * documenta como configurable solo `[dominio]:[puerto]`.
   *
   * Sin auth propia: el manual no define ninguna para esta dirección (el
   * Bearer es solo para las llamadas comercio -> banco). Por eso NUNCA se
   * confía en el body para cambiar estado: solo dispara una re-verificación
   * con `statusQR`, igual que un tick del cron. Lo peor que puede lograr
   * alguien sin credenciales es forzar una consulta de más — nunca
   * falsificar un pago.
   *
   * Responde `{responseCode, message}` con 200, que es el contrato que
   * espera el banco (responseCode != 0 = error de nuestro lado).
   */
  @Post('api/qrsimple/notifyPaymentQR')
  @HttpCode(200)
  async notifyPayment(@Body() body: unknown) {
    const qrId = extractQrId(body);
    try {
      await this.qrPayments.recordNotifyPayload(qrId, body);
      if (qrId) await this.qrPayments.resolveCharge(qrId);
    } catch {
      // El cron reintenta igual, así que un fallo acá no pierde el pago;
      // se le informa al banco para que quede en su traza.
      this.logger.error('notifyPaymentQR failed');
      return { responseCode: 1, message: 'Error procesando la notificación.' };
    }
    if (!qrId) {
      this.logger.warn('notifyPaymentQR missing recognizable qrId');
      return { responseCode: 1, message: 'Falta qrId en la notificación.' };
    }
    return { responseCode: 0, message: '' };
  }
}
