import { ApiProperty } from '@nestjs/swagger';
import { DASHBOARD_USER_ROLE_VALUES } from '../../common/api-enums';
import { DashboardUserRole } from '../../database/types';

export class LoginUserResponse {
  id!: string;
  username!: string;
  @ApiProperty({ enum: DASHBOARD_USER_ROLE_VALUES })
  role!: DashboardUserRole;
}

export class LoginResponse {
  accessToken!: string;
  user!: LoginUserResponse;
}

export class StaffUserResponse {
  id!: string;
  username!: string;
  @ApiProperty({ enum: DASHBOARD_USER_ROLE_VALUES })
  role!: DashboardUserRole;
  isActive!: boolean;
  createdAt!: string;
}
