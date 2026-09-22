import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

/**
 * Only the service and its routes live here. The password hasher, token issuer,
 * revocation cache and OTP store are provided globally by CommonModule, because
 * two of them are stateful and every one of them is used outside sign-in.
 */
@Module({
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
