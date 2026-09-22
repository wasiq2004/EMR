import { Module } from '@nestjs/common';
import { CommsController } from './comms.controller';
import { CommsService } from './comms.service';
import { MessagingModule } from '../messaging/messaging.module';

/**
 * Imports MessagingModule for the WhatsApp client and the account's credential.
 * A chat reply and a broadcast reach the provider through exactly the same two
 * services, so a change to how sending works cannot apply to one and not the
 * other.
 */
@Module({
  imports: [MessagingModule],
  controllers: [CommsController],
  providers: [CommsService],
  exports: [CommsService],
})
export class CommsModule {}
