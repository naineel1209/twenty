import { Logger } from '@nestjs/common';

import { Like } from 'typeorm';

import { ObjectMetadataInterface } from 'src/engine/metadata-modules/field-metadata/interfaces/object-metadata.interface';

import {
  CallWebhookJob,
  CallWebhookJobData,
} from 'src/engine/api/graphql/workspace-query-runner/jobs/call-webhook.job';
import { User } from 'src/engine/core-modules/user/user.entity';
import { InjectMessageQueue } from 'src/engine/integrations/message-queue/decorators/message-queue.decorator';
import { Process } from 'src/engine/integrations/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/integrations/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/integrations/message-queue/message-queue.constants';
import { MessageQueueService } from 'src/engine/integrations/message-queue/services/message-queue.service';
import { TwentyORMGlobalManager } from 'src/engine/twenty-orm/twenty-orm-global.manager';
import { WebhookWorkspaceEntity } from 'src/modules/webhook/standard-objects/webhook.workspace-entity';

export enum CallWebhookJobsJobOperation {
  create = 'create',
  update = 'update',
  delete = 'delete',
}

export type CallWebhookJobsJobData = {
  workspaceId: string;
  objectMetadataItem: ObjectMetadataInterface;
  record: any;
  operation: CallWebhookJobsJobOperation;
  creatorDetails: Pick<User, 'firstName' | 'lastName'>
};

@Processor(MessageQueue.webhookQueue)
export class CallWebhookJobsJob {
  private readonly logger = new Logger(CallWebhookJobsJob.name);

  constructor(
    @InjectMessageQueue(MessageQueue.webhookQueue)
    private readonly messageQueueService: MessageQueueService,
    private readonly twentyORMGlobalManager: TwentyORMGlobalManager,
  ) {}

  @Process(CallWebhookJobsJob.name)
  async handle(data: CallWebhookJobsJobData): Promise<void> {
    const webhookRepository =
      await this.twentyORMGlobalManager.getRepositoryForWorkspace<WebhookWorkspaceEntity>(
        data.workspaceId,
        'webhook',
      );

    const nameSingular = data.objectMetadataItem.nameSingular;
    const operation = data.operation;
    const eventName = `${nameSingular}.${operation}`;
    const creatorDetails = data.creatorDetails;

    const webhooks = await webhookRepository.find({
      where: [
        { operation: Like(`%${eventName}%`) },
        { operation: Like(`%*.${operation}%`) },
        { operation: Like(`%${nameSingular}.*%`) },
        { operation: Like('%*.*%') },
      ],
    });

    webhooks.forEach((webhook) => {
      this.messageQueueService.add<CallWebhookJobData>(
        CallWebhookJob.name,
        {
          targetUrl: webhook.targetUrl,
          eventName,
          objectMetadata: {
            id: data.objectMetadataItem.id,
            nameSingular: data.objectMetadataItem.nameSingular,
          },
          workspaceId: data.workspaceId,
          webhookId: webhook.id,
          eventDate: new Date(),
          record: data.record,
          creatorDetails,
        },
        { retryLimit: 3 },
      );
    });

    if (webhooks.length) {
      this.logger.log(
        `CallWebhookJobsJob on eventName '${eventName}' called on webhooks ids [\n"${webhooks
          .map((webhook) => webhook.id)
          .join('",\n"')}"\n]`,
      );
    }
  }
}
