import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QueuesModule } from '../queues/queues.module';
import { OutboxEvent } from './outbox-event.entity';
import { BullmqOutboxPublisher, OUTBOX_PUBLISHER } from './outbox-publisher';
import { OutboxRelay } from './outbox-relay.service';
import { OutboxService } from './outbox.service';

@Module({
  imports: [TypeOrmModule.forFeature([OutboxEvent]), QueuesModule],
  providers: [
    OutboxService,
    OutboxRelay,
    { provide: OUTBOX_PUBLISHER, useClass: BullmqOutboxPublisher },
  ],
  exports: [OutboxService, OutboxRelay],
})
export class OutboxModule {}
