import { IsString, MaxLength, MinLength } from 'class-validator';

export class AppendOrderNoteDto {
  @IsString()
  @MinLength(6)
  @MaxLength(32)
  customerPhone!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  note!: string;

  /** wamid del mensaje — deduplica reintentos (Idempotency por sourceMessageId, mismo patrón que locations/attach). */
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  sourceMessageId!: string;
}
