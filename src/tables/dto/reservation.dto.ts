import {
  IsBoolean,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateReservationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  customerName!: string;

  @IsString()
  @MinLength(5)
  @MaxLength(30)
  customerPhone!: string;

  @IsInt()
  @Min(1)
  @Max(100)
  partySize!: number;

  /** Uno de los horarios de la disponibilidad, en ISO 8601 (ej. 2026-10-16T20:00:00-04:00). */
  @IsISO8601()
  startsAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class CancelReservationDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;

  /** Solo staff: devolver el adelanto aunque esté dentro del plazo en que se pierde. */
  @IsOptional()
  @IsBoolean()
  refund?: boolean;
}

export class UpdateReservationSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  depositAmount?: number;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(240)
  slotMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(480)
  blockMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  holdMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  paymentTtlMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(168)
  cancelRefundHours?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  minLeadMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  maxDaysAhead?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  /** Tope de personas con reserva el mismo día. */
  maxPeoplePerDay?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(600)
  lastSlotBeforeCloseMinutes?: number;
}
