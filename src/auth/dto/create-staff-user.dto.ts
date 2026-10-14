import { IsIn, IsString, MinLength } from 'class-validator';
import { DashboardUserRole } from '../../database/types';

const ROLES: DashboardUserRole[] = ['admin', 'kitchen', 'cashier', 'delivery'];

export class CreateStaffUserDto {
  @IsString()
  @MinLength(3)
  username!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsIn(ROLES)
  role!: DashboardUserRole;
}
