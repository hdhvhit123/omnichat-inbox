'use client';
import { useMemo, useState } from 'react';
import { qs } from '@/lib/api';
import { fmtDuration, fmtPct, fmtUsd, TZ } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { AI_STATUS, CONV_STATUS } from '@/lib/labels';
import { Card, ErrorBox, Field, Input, Notice, PageHeader, Select, Spinner, Table } from '@/components/ui';

/** Ngày theo giờ Việt Nam → mốc UTC đầu ngày. */
function vnStartOfDay(day: string) {
  return new Date(`${day}T00:00:00+07:00`).toISOString();
}
function todayVn(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
}

export default function ReportsPage() {
  const [from, setFrom] = useState(todayVn(-6));
  const [to, setTo] = useState(todayVn());
  const [channelId, setChannelId] = useState('');
  const channels = useApi<{ items: any[] }>('/channels');
  const path = useMemo(() => `/reports/summary${qs({ from: vnStartOfDay(from), to: new Date(new Date(vnStartOfDay(to)).getTime() + 86400_000).toISOString(), channelId })}`, [from, to, channelId]);
  const r = useApi<any>(path);
  const d = r.data;
  const max = d ? Math.max(1, ...d.daily.map((x: any) => x.inbound + x.agent + x.bot)) : 1;

  return (
    <div className="space-y-4 p-6">
      <PageHeader title="Báo cáo" description="Mốc ngày theo giờ Việt Nam (Asia/Ho_Chi_Minh). Lời chào và tin tự động không được tính là phản hồi của nhân viên." />
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Từ ngày">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Đến ngày">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="Kênh">
          <Select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
            <option value="">Tất cả</option>
            {channels.data?.items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {r.error ? (
        <ErrorBox error={r.error} onRetry={r.reload} />
      ) : !d ? (
        <Spinner />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric label="Hội thoại mới" value={d.newConversations} def="Hội thoại có tin đầu tiên của khách trong kỳ." />
            <Metric label="Phản hồi đầu tiên của nhân viên" value={`${fmtDuration(d.firstResponse.medianSeconds)} (TV)`} sub={`Trung bình ${fmtDuration(d.firstResponse.avgSeconds)} · ${d.firstResponse.sample} hội thoại`} def="Từ tin đầu của khách tới tin đầu do nhân viên gửi thành công. Không tính lời chào, quy tắc, bot." />
            <Metric label="Đã giải quyết" value={d.resolved} def="Hội thoại được chuyển sang Đã giải quyết trong kỳ (lần gần nhất)." />
            <Metric label="Tồn đọng hiện tại" value={Object.values(d.backlog as Record<string, number>).reduce((a, b) => a + b, 0)} sub={Object.entries(d.backlog).map(([k, v]) => `${CONV_STATUS[k]?.label}: ${v}`).join(' · ')} def="Hội thoại hiện ở trạng thái Mới / Đang xử lý / Chờ khách." />
            <Metric label="Bot tự giải quyết" value={fmtPct(d.bot.botResolvedRate)} sub={`${d.bot.resolvedByBot} hội thoại`} def="Trong số đã giải quyết: có tin bot gửi thành công và không có tin nhân viên." />
            <Metric label="Tỷ lệ chuyển nhân viên" value={fmtPct(d.bot.handoffRate)} sub={`${d.bot.handedOff}/${d.bot.conversationsWithBot} hội thoại có bot`} def="Hội thoại có tin bot trong kỳ và đã được chuyển nhân viên." />
            <Metric label="Lỗi gửi" value={Object.values(d.sendErrors.byStatus as Record<string, number>).reduce((a, b) => a + b, 0)} sub={`/ ${d.sendErrors.total} tin gửi · ${Object.entries(d.sendErrors.byStatus).map(([k, v]) => `${k === 'FAILED' ? 'Thất bại' : k === 'UNKNOWN' ? 'Chưa xác định' : 'Bị chặn'}: ${v}`).join(' · ')}`} def="Tin gửi đi có trạng thái Thất bại / Chưa xác định / Bị chặn." />
            <Metric label="Chi phí AI ước tính" value={fmtUsd(d.ai.costUsd)} sub={`${d.ai.tasks} tác vụ · ${d.ai.inputTokens.toLocaleString('vi-VN')}/${d.ai.outputTokens.toLocaleString('vi-VN')} token`} def="Token × đơn giá quản trị viên nhập. Không phải hoá đơn của nhà cung cấp." />
          </div>
          <Notice tone="info">Phí nền tảng (Meta/Zalo): {d.platformFees.note}.</Notice>
          <Card title="Tin nhắn theo ngày">
            {d.daily.length === 0 ? (
              <p className="text-sm text-gray-500">Không có dữ liệu trong kỳ.</p>
            ) : (
              <div className="space-y-1">
                {d.daily.map((x: any) => (
                  <div key={x.day} className="flex items-center gap-2 text-xs">
                    <span className="w-20 text-gray-500">{x.day.split('-').reverse().join('/')}</span>
                    <div className="flex h-4 flex-1 overflow-hidden rounded bg-gray-100">
                      <div className="bg-gray-400" style={{ width: `${(x.inbound / max) * 100}%` }} title={`Khách: ${x.inbound}`} />
                      <div className="bg-brand-500" style={{ width: `${(x.agent / max) * 100}%` }} title={`Nhân viên: ${x.agent}`} />
                      <div className="bg-violet-400" style={{ width: `${(x.bot / max) * 100}%` }} title={`Bot: ${x.bot}`} />
                    </div>
                    <span className="w-40 text-gray-600">
                      {x.inbound} khách · {x.agent} NV · {x.bot} bot
                    </span>
                  </div>
                ))}
                <div className="flex gap-3 pt-2 text-xs text-gray-500">
                  <span className="flex items-center gap-1"><span className="h-2 w-3 bg-gray-400" />Khách</span>
                  <span className="flex items-center gap-1"><span className="h-2 w-3 bg-brand-500" />Nhân viên</span>
                  <span className="flex items-center gap-1"><span className="h-2 w-3 bg-violet-400" />Bot</span>
                </div>
              </div>
            )}
          </Card>
          <Card title="Tác vụ AI theo kết quả">
            <Table head={['Kết quả', 'Số lượng']}>
              {Object.entries(d.ai.byStatus).map(([k, v]) => (
                <tr key={k}>
                  <td className="px-3 py-2">{AI_STATUS[k] ?? k}</td>
                  <td className="px-3 py-2">{v as number}</td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}
    </div>
  );
}

function Metric({ label, value, sub, def }: { label: string; value: string | number; sub?: string; def: string }) {
  return (
    <div className="rounded-lg border bg-white p-4" title={def}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-gray-500">{sub}</div>}
      <div className="mt-2 text-[11px] leading-snug text-gray-400">{def}</div>
    </div>
  );
}
