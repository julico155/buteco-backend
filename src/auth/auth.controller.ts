import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { CreateStaffUserDto } from './dto/create-staff-user.dto';
import { SetStaffUserActiveDto } from './dto/set-staff-user-active.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { Roles } from './roles.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  // Solo un admin ya logueado puede dar de alta más staff. El primer admin
  // se sigue creando por SQL directo — arranque en frío inevitable.
  @Post('users')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  createUser(@Body() dto: CreateStaffUserDto) {
    return this.auth.createStaffUser(dto);
  }

  @Get('users')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  listUsers() {
    return this.auth.listStaffUsers();
  }

  @Patch('users/:id/active')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  setActive(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetStaffUserActiveDto) {
    return this.auth.setActive(id, dto.active);
  }
}
