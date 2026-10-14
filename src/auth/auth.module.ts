import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AppConfig } from '../config/configuration';
import { AdminBootstrapService } from './admin-bootstrap.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';

const jwtModule = JwtModule.registerAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService<AppConfig, true>) => {
    const jwt = config.get('jwt', { infer: true });
    // expiresIn de @nestjs/jwt tipa contra el union literal de jsonwebtoken
    // (ej. '8h'), no contra `string` genérico. JWT_SECRET ya fue validado
    // al cargar la configuración de la aplicación.
    return { secret: jwt.secret, signOptions: { expiresIn: jwt.expiresIn as any } };
  },
});

@Module({
  imports: [jwtModule],
  controllers: [AuthController],
  providers: [AuthService, AdminBootstrapService, JwtAuthGuard, RolesGuard],
  // Exportar jwtModule (no solo los guards) es necesario: JwtAuthGuard
  // depende de JwtService, y los módulos que importan AuthModule solo para
  // usar el guard también necesitan poder resolver esa dependencia.
  exports: [jwtModule, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
