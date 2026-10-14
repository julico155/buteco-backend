import { IsBoolean } from 'class-validator';

export class SetActiveDto {
  @IsBoolean()
  active!: boolean;
}

export class SetArchivedDto {
  @IsBoolean()
  archived!: boolean;
}
