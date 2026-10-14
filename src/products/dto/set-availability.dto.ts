import { IsBoolean } from 'class-validator';

export class SetAvailabilityDto {
  @IsBoolean()
  available!: boolean;
}
