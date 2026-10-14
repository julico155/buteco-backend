import { IsBoolean } from 'class-validator';

export class SetStaffUserActiveDto {
  @IsBoolean()
  active!: boolean;
}
