import { Controller, Get, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ADMIN_ROLES, Roles, Ws, WorkspaceCtx } from '../auth/context';
import { PrismaService } from '../common/prisma.service';

/**
 * Định nghĩa chỉ số (cũng hiển thị trên giao diện):
 * - Hội thoại mới: hội thoại được tạo trong kỳ (tin đầu tiên của khách tới trong kỳ).
 * - Tồn đọng: hội thoại hiện ở trạng thái Mới / Đang xử lý / Chờ khách.
 * - Thời gian phản hồi đầu tiên: từ tin đầu tiên của khách tới tin đầu tiên do NHÂN VIÊN gửi
 *   (không tính lời chào tự động, quy tắc, bot; không tính tin bị chặn/thất bại). Trung vị và trung bình.
 * - Đã giải quyết: hội thoại có thời điểm giải quyết trong kỳ (lần giải quyết gần nhất).
 * - Tỷ lệ bot xử lý: hội thoại đã giải quyết trong kỳ, có tin bot đã gửi và không có tin nhân viên nào.
 * - Tỷ lệ chuyển nhân viên: hội thoại có tin bot trong kỳ và đã được chuyển nhân viên.
 * - Lỗi gửi: tin gửi đi có trạng thái Thất bại / Chưa xác định / Bị chặn trong kỳ.
 * - Chi phí AI: tổng chi phí ước tính theo token × đơn giá quản trị viên cấu hình.
 */
@Roles(...ADMIN_ROLES, 'VIEWER')
@Controller('reports')
export class ReportsController {
  constructor(private prisma: PrismaService) {}

  @Get('summary')
  async summary(@Ws() ws: WorkspaceCtx, @Query('from') fromRaw?: string, @Query('to') toRaw?: string, @Query('channelId') channelId?: string) {
    const to = toRaw ? new Date(toRaw) : new Date();
    const from = fromRaw ? new Date(fromRaw) : new Date(to.getTime() - 7 * 86400_000);
    const w = ws.workspaceId;
    const chFilter = channelId ? Prisma.sql`AND c."channelId" = ${channelId}` : Prisma.empty;
    const chWhere = channelId ? { channelId } : {};

    const [newConversations, backlog, resolved] = await Promise.all([
      this.prisma.conversation.count({ where: { workspaceId: w, ...chWhere, createdAt: { gte: from, lt: to } } }),
      this.prisma.conversation.groupBy({ by: ['status'], where: { workspaceId: w, ...chWhere, status: { in: ['NEW', 'OPEN', 'PENDING'] } }, _count: true }),
      this.prisma.conversation.count({ where: { workspaceId: w, ...chWhere, resolvedAt: { gte: from, lt: to } } }),
    ]);

    const frt = await this.prisma.$queryRaw<{ median: number | null; avg: number | null; n: bigint }[]>(Prisma.sql`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY secs) AS median, avg(secs) AS avg, count(*) AS n FROM (
        SELECT EXTRACT(EPOCH FROM (MIN(m."sentAt") - c."firstInboundAt")) AS secs
        FROM "Conversation" c JOIN "Message" m ON m."conversationId" = c.id
        WHERE c."workspaceId" = ${w} ${chFilter} AND c."firstInboundAt" >= ${from} AND c."firstInboundAt" < ${to}
          AND m."senderType" = 'AGENT' AND m.direction = 'OUTBOUND' AND m."sentOutsideSystem" = false
          AND m.status NOT IN ('FAILED','BLOCKED','CANCELLED')
        GROUP BY c.id, c."firstInboundAt") t`);

    const bot = await this.prisma.$queryRaw<{ resolved_by_bot: bigint; with_bot: bigint; handed_off: bigint }[]>(Prisma.sql`
      SELECT
        count(*) FILTER (WHERE c."resolvedAt" >= ${from} AND c."resolvedAt" < ${to} AND has_bot AND NOT has_agent) AS resolved_by_bot,
        count(*) FILTER (WHERE has_bot) AS with_bot,
        count(*) FILTER (WHERE has_bot AND c."handoffAt" IS NOT NULL) AS handed_off
      FROM "Conversation" c
      CROSS JOIN LATERAL (
        SELECT bool_or(m."senderType" = 'BOT' AND m.status IN ('ACCEPTED','DELIVERED','READ')) AS has_bot,
               bool_or(m."senderType" = 'AGENT' AND m.direction = 'OUTBOUND') AS has_agent
        FROM "Message" m WHERE m."conversationId" = c.id AND m."sentAt" >= ${from} AND m."sentAt" < ${to}) s
      WHERE c."workspaceId" = ${w} ${chFilter}`);

    const sendErrors = await this.prisma.message.groupBy({
      by: ['status'],
      where: { workspaceId: w, ...chWhere, direction: 'OUTBOUND', status: { in: ['FAILED', 'UNKNOWN', 'BLOCKED'] }, sentAt: { gte: from, lt: to } },
      _count: true,
    });
    const outboundTotal = await this.prisma.message.count({ where: { workspaceId: w, ...chWhere, direction: 'OUTBOUND', sentOutsideSystem: false, sentAt: { gte: from, lt: to } } });

    const ai = await this.prisma.aiTask.aggregate({ where: { workspaceId: w, createdAt: { gte: from, lt: to } }, _sum: { costUsd: true, inputTokens: true, outputTokens: true }, _count: true });
    const aiByStatus = await this.prisma.aiTask.groupBy({ by: ['status'], where: { workspaceId: w, createdAt: { gte: from, lt: to } }, _count: true });

    const channels = await this.prisma.channel.findMany({ where: { workspaceId: w }, select: { id: true, name: true, type: true, status: true, lastWebhookAt: true, lastApiSuccessAt: true, lastError: true, isSimulated: true } });

    const daily = await this.prisma.$queryRaw<{ day: string; inbound: bigint; agent: bigint; bot: bigint }[]>(Prisma.sql`
      SELECT to_char((m."sentAt" AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD') AS day,
        count(*) FILTER (WHERE m.direction = 'INBOUND') AS inbound,
        count(*) FILTER (WHERE m."senderType" = 'AGENT' AND m.direction = 'OUTBOUND') AS agent,
        count(*) FILTER (WHERE m."senderType" = 'BOT') AS bot
      FROM "Message" m JOIN "Conversation" c ON c.id = m."conversationId"
      WHERE m."workspaceId" = ${w} ${chFilter} AND m."sentAt" >= ${from} AND m."sentAt" < ${to}
      GROUP BY 1 ORDER BY 1`);

    const b = bot[0];
    const withBot = Number(b?.with_bot ?? 0);
    return {
      range: { from, to },
      newConversations,
      backlog: Object.fromEntries(backlog.map((r) => [r.status, r._count])),
      firstResponse: { medianSeconds: frt[0]?.median ?? null, avgSeconds: frt[0]?.avg != null ? Number(frt[0].avg) : null, sample: Number(frt[0]?.n ?? 0) },
      resolved,
      bot: {
        resolvedByBot: Number(b?.resolved_by_bot ?? 0),
        botResolvedRate: resolved ? Number(b?.resolved_by_bot ?? 0) / resolved : null,
        conversationsWithBot: withBot,
        handedOff: Number(b?.handed_off ?? 0),
        handoffRate: withBot ? Number(b?.handed_off ?? 0) / withBot : null,
      },
      sendErrors: { total: outboundTotal, byStatus: Object.fromEntries(sendErrors.map((r) => [r.status, r._count])) },
      ai: { tasks: ai._count, costUsd: Number(ai._sum.costUsd ?? 0), inputTokens: ai._sum.inputTokens ?? 0, outputTokens: ai._sum.outputTokens ?? 0, byStatus: Object.fromEntries(aiByStatus.map((r) => [r.status, r._count])) },
      platformFees: { available: false, note: 'Chưa có dữ liệu phí nền tảng được xác thực' },
      channels,
      daily: daily.map((d) => ({ day: d.day, inbound: Number(d.inbound), agent: Number(d.agent), bot: Number(d.bot) })),
    };
  }
}
