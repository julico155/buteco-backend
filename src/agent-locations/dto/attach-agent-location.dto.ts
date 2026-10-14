import { IsLatitude, IsLongitude, IsString, MaxLength, MinLength } from 'class-validator';

export class AttachAgentLocationDto {
  /** wa_id / teléfono tal como llega de WhatsApp; Central lo normaliza (ver normalizePhone). */
  @IsString()
  @MinLength(6)
  @MaxLength(32)
  customerPhone!: string;

  @IsLatitude()
  latitude!: number;

  @IsLongitude()
  longitude!: number;

  /** wamid del mensaje de ubicación: deduplica reintentos (Idempotency por sourceMessageId). */
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  sourceMessageId!: string;
}
