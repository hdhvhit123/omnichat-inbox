import { Message } from '@prisma/client';

export function serializeMessage(m: Message) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    direction: m.direction,
    senderType: m.senderType,
    authorId: m.authorId,
    text: m.text,
    attachments: m.attachments,
    status: m.status,
    errorCode: m.errorCode,
    errorMessage: m.errorMessage,
    sentAt: m.sentAt.toISOString(),
    deliveredAt: m.deliveredAt?.toISOString() ?? null,
    readAt: m.readAt?.toISOString() ?? null,
    sentOutsideSystem: m.sentOutsideSystem,
    ruleId: m.ruleId,
    aiTaskId: m.aiTaskId,
    clientMsgId: m.clientMsgId,
  };
}
