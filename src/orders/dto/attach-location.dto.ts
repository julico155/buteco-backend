import { IsLatitude, IsLongitude } from 'class-validator';

export class AttachLocationDto {
  @IsLatitude()
  latitude!: number;

  @IsLongitude()
  longitude!: number;
}
