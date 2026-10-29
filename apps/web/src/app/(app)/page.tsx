'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fmtDuration, fmtRelative, fmtUsd } from '@/lib/format';
import { CHANNEL_LABEL, CHANNEL_STATUS } from '@/lib/labels';
import { useSession } from '@/lib/session';
import { Badge, Card, Notice, PageHeader } from '@/components/ui';
import { SimulatorPanel } from '@/components/inbox/SimulatorPanel';

function Stat({ label, value, href, tone }: { label: string; value: string | number; href?: string; tone?: string }) {
  const body = (
    <div className="rounded-lg border bg-white p-4 hover:border-brand-500">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${tone ?? ''}`}>{value}</div>
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

export default function Dashboard() {
  const { ws, can, user } = useSession();
  const [counts, setCounts] = useState({ mine: 0, unassigned: 0, unhandled: 0, handoff: 0 });
  const [channels, setChannels] = useState<any[]>([]);
  const [report, setReport] = useState<any>(null);

  useEffect(() => {
    Promise.all([
      api('/conversations?status=ACTIVE&assignee=me&limit=100'),
      api('/conversations?status=ACTIVE&assignee=none&limit=100'),
      api('/conversations/unhandled-count'),
      api('/conversations?status=ACTIVE&limit=100'),
    ])
      .then(([mine, un, uh, all]) => setCounts({ mine: mine.items.length, unassigned: un.items.length, unhandled: uh.count, handoff: all.items.filter((c: any) => c.handoffAt && c.botPaused).length }))
      .catch(() => undefined);
    api('/channels').then((r) => setChannels(r.items)).catch(() => undefined);
    if (ws.role !== 'AGENT') api('/reports/summary').then(setReport).catch(() => undefined);
  }, [ws.role]);

  const broken = channels.filter((c) => c.status !== 'CONNECTED');
  return (
    <div className="p-6">
      <PageHeader title={`Xin chào, ${user.name}`} description="Tổng quan công việc chăm sóc khách hàng hôm nay." actions={ws.isDemo && can.write ? <SimulatorPanel /> : undefined} />
      {ws.isDemo && (
        <div className="mb-4">
          <Notice tone="warn">
            <b>Dữ liệu mô phỏng.</b> Workspace này dùng kênh giả lập, không kết nối Facebook/Zalo thật và không gửi tin ra ngoài. Dữ liệu tách biệt hoàn toàn với workspace thật.
          </Notice>
        </div>
      )}
      {broken.length > 0 && (
        <div className="mb-4">
          <Notice tone="error">
            {broken.length} kênh chưa hoạt động bình thường: {broken.map((c) => c.name).join(', ')}.{' '}
            <Link className="underline" href="/channels">
              Kiểm tra kết nối
            </Link>
          </Notice>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Hội thoại của tôi đang mở" value={counts.mine} href="/inbox" />
        <Stat label="Chưa phân công" value={counts.unassigned} href="/inbox" />
        <Stat label="Có tin chưa đọc chưa xử lý" value={counts.unhandled} tone={counts.unhandled ? 'text-red-600' : ''} href="/inbox" />
        <Stat label="Bot chuyển cho nhân viên" value={counts.handoff} tone={counts.handoff ? 'text-orange-600' : ''} href="/inbox" />
      </div>

      {report && (
        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Hội thoại mới (7 ngày)" value={report.newConversations} href="/reports" />
          <Stat label="Phản hồi đầu tiên của nhân viên (trung vị)" value={fmtDuration(report.firstResponse.medianSeconds)} href="/reports" />
          <Stat label="Đã giải quyết (7 ngày)" value={report.resolved} href="/reports" />
          <Stat label="Chi phí AI (7 ngày)" value={fmtUsd(report.ai.costUsd)} href="/reports" />
        </div>
      )}

      <Card title="Tình trạng kênh" className="mt-6" actions={<Link href="/channels" className="text-sm text-brand-600">Quản lý</Link>}>
        {channels.length === 0 ? (
          <p className="text-sm text-gray-500">Chưa có kênh nào. {can.owner ? 'Vào Kết nối kênh để thêm Fanpage hoặc Zalo OA.' : ''}</p>
        ) : (
          <ul className="divide-y text-sm">
            {channels.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="w-20 text-gray-500">{CHANNEL_LABEL[c.type]}</span>
                <span className="flex-1 font-medium">{c.name}</span>
                {c.isSimulated && <Badge className="bg-amber-100 text-amber-900">Mô phỏng</Badge>}
                <Badge className={CHANNEL_STATUS[c.status]?.cls}>{CHANNEL_STATUS[c.status]?.label}</Badge>
                <span className="text-xs text-gray-500">Webhook gần nhất: {fmtRelative(c.lastWebhookAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
