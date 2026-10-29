'use client';
import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { api, download } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, Notice, PageHeader, Select, Spinner, Table, Textarea, Toggle, useToast } from '@/components/ui';

const TABS = [
  ['general', 'Cài đặt chung'],
  ['policies', 'Chính sách gửi tin'],
  ['ops', 'Độ tin cậy'],
  ['audit', 'Nhật ký thao tác'],
  ['data', 'Dữ liệu & bảo mật'],
] as const;
const DAYS: [string, string][] = [['mon', 'Thứ 2'], ['tue', 'Thứ 3'], ['wed', 'Thứ 4'], ['thu', 'Thứ 5'], ['fri', 'Thứ 6'], ['sat', 'Thứ 7'], ['sun', 'Chủ nhật']];

export default function SettingsPage() {
  const { can } = useSession();
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('general');
  const visible = TABS.filter(([k]) => can.admin || k === 'general' || k === 'policies' || k === 'data');
  return (
    <div className="p-6">
      <PageHeader title="Cài đặt & nhật ký" />
      <div className="mb-4 flex gap-1 border-b">
        {visible.map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={clsx('-mb-px border-b-2 px-3 py-2 text-sm', tab === k ? 'border-brand-600 font-medium text-brand-700' : 'border-transparent text-gray-600 hover:text-gray-900')}>
            {l}
          </button>
        ))}
      </div>
      {tab === 'general' && <General />}
      {tab === 'policies' && <Policies />}
      {tab === 'ops' && <Ops />}
      {tab === 'audit' && <Audit />}
      {tab === 'data' && <DataSecurity />}
    </div>
  );
}

function General() {
  const { can } = useSession();
  const toast = useToast();
  const w = useApi<{ workspace: any }>('/workspace');
  const [f, setF] = useState<any>(null);
  useEffect(() => {
    if (w.data) setF({ ...w.data.workspace, businessHours: w.data.workspace.businessHours ?? {} });
  }, [w.data]);
  if (w.error) return <ErrorBox error={w.error} onRetry={w.reload} />;
  if (!f) return <Spinner />;
  const ro = !can.owner;
  const setDay = (d: string, range: [string, string] | null) => setF({ ...f, businessHours: { ...f.businessHours, [d]: range ? [range] : [] } });

  async function save() {
    try {
      await api('/workspace', { method: 'PATCH', body: { name: f.name, businessHours: f.businessHours, retentionDays: f.retentionDays ? Number(f.retentionDays) : null, fbHumanAgentTagEnabled: f.fbHumanAgentTagEnabled } });
      toast('Đã lưu cài đặt');
      w.reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }
  return (
    <div className="space-y-4">
      {ro && <Notice tone="info">Chỉ Chủ sở hữu được thay đổi các cài đặt này.</Notice>}
      <Card title="Workspace">
        <div className="grid max-w-2xl gap-3 md:grid-cols-2">
          <Field label="Tên workspace">
            <Input disabled={ro} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label="Múi giờ hiển thị">
            <Input disabled value="Asia/Ho_Chi_Minh (UTC+7)" />
          </Field>
          <Field label="Thời gian lưu trữ tin nhắn (ngày)" hint="Để trống = không tự xoá. Tối thiểu 30 ngày.">
            <Input type="number" min={30} disabled={ro} value={f.retentionDays ?? ''} onChange={(e) => setF({ ...f, retentionDays: e.target.value })} />
          </Field>
        </div>
      </Card>
      <Card title="Giờ làm việc" actions={<span className="text-xs text-gray-500">Dùng cho quy tắc “Ngoài giờ làm việc”</span>}>
        <div className="space-y-2">
          {DAYS.map(([d, l]) => {
            const r: [string, string] | undefined = f.businessHours[d]?.[0];
            return (
              <div key={d} className="flex items-center gap-3 text-sm">
                <span className="w-20">{l}</span>
                <Toggle label={`Làm việc ${l}`} disabled={ro} checked={!!r} onChange={(v) => setDay(d, v ? ['08:00', '17:30'] : null)} />
                {r ? (
                  <>
                    <Input type="time" className="w-32" disabled={ro} value={r[0]} onChange={(e) => setDay(d, [e.target.value, r[1]])} />
                    <span>đến</span>
                    <Input type="time" className="w-32" disabled={ro} value={r[1]} onChange={(e) => setDay(d, [r[0], e.target.value])} />
                  </>
                ) : (
                  <span className="text-gray-500">Nghỉ</span>
                )}
              </div>
            );
          })}
        </div>
      </Card>
      <Card title="Facebook: tin nhắn của nhân viên sau 24 giờ (HUMAN_AGENT)">
        <div className="flex items-start gap-3">
          <Toggle label="Bật HUMAN_AGENT" disabled={ro} checked={f.fbHumanAgentTagEnabled} onChange={(v) => setF({ ...f, fbHumanAgentTagEnabled: v })} />
          <p className="text-sm text-gray-700">
            Chỉ bật khi ứng dụng Meta của bạn <b>đã được duyệt quyền Human Agent</b>. Khi bật, chỉ nhân viên (không phải bot/quy tắc) được trả lời trong 7 ngày kể từ tin cuối của khách, với tag HUMAN_AGENT. Dùng sai mục đích có thể khiến trang bị hạn chế.
          </p>
        </div>
      </Card>
      {!ro && <Button onClick={save}>Lưu cài đặt</Button>}
    </div>
  );
}

function Policies() {
  const { can } = useSession();
  const toast = useToast();
  const p = useApi<{ items: any[] }>('/policies');
  const [add, setAdd] = useState<any>(null);
  return (
    <div className="space-y-3">
      <Notice tone="info">
        Mọi tin gửi đi (nhân viên, chatbot, quy tắc, tác vụ nền) đều qua một dịch vụ kiểm tra điều kiện duy nhất dựa trên các quy tắc dưới đây. Quy tắc có phiên bản và ngày hiệu lực; chỉ Chủ sở hữu được tạo phiên bản mới và mọi thay đổi được ghi nhật ký. Mục “Nguồn phụ” cần đối chiếu lại với tài liệu chính thức.
      </Notice>
      <Card title="Quy tắc chính sách" actions={can.owner && <Button size="sm" onClick={() => setAdd({ channelType: 'FACEBOOK', category: 'RESPONSE', windowHours: 24, allowedSenders: ['AGENT', 'BOT', 'RULE'], effectiveFrom: new Date().toISOString().slice(0, 16), sourceUrl: '', verificationStatus: 'VERIFIED', notes: '' })}>Tạo phiên bản mới</Button>}>
        {p.error ? (
          <ErrorBox error={p.error} />
        ) : !p.data ? (
          <Spinner />
        ) : (
          <Table head={['Kênh', 'Loại', 'Phiên bản', 'Cửa sổ', 'Người gửi', 'Hiệu lực', 'Xác minh', 'Phạm vi', '']}>
            {p.data.items.map((r) => (
              <tr key={r.id} className={r.active ? '' : 'opacity-50'}>
                <td className="px-3 py-2">{r.channelType === 'FACEBOOK' ? 'Facebook' : 'Zalo'}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.category}</td>
                <td className="px-3 py-2">v{r.version}</td>
                <td className="px-3 py-2">{r.windowHours} giờ</td>
                <td className="px-3 py-2 text-xs">{r.allowedSenders.join(', ')}</td>
                <td className="px-3 py-2 text-xs">
                  {fmtDateTime(r.effectiveFrom)}
                  {r.effectiveTo && ` → ${fmtDateTime(r.effectiveTo)}`}
                </td>
                <td className="px-3 py-2">
                  <Badge className={r.verificationStatus === 'VERIFIED' ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-900'}>{r.verificationStatus === 'VERIFIED' ? 'Đã đối chiếu' : 'Nguồn phụ'}</Badge>
                  <a href={r.sourceUrl} target="_blank" rel="noreferrer noopener" className="ml-1 text-xs text-brand-600 underline">
                    nguồn
                  </a>
                  <div className="text-[11px] text-gray-500">Kiểm tra: {fmtDateTime(r.verifiedAt)}</div>
                </td>
                <td className="px-3 py-2 text-xs">{r.workspaceId ? 'Workspace' : 'Mặc định'}</td>
                <td className="px-3 py-2">
                  {can.owner && r.workspaceId && r.active && (
                    <Button size="sm" variant="ghost" onClick={async () => { await api(`/policies/${r.id}/deactivate`, { method: 'POST' }).catch((e) => toast(e.message, 'error')); p.reload(); }}>
                      Vô hiệu
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {add && (
        <Modal
          open
          onClose={() => setAdd(null)}
          title="Phiên bản quy tắc mới"
          footer={
            <Button
              onClick={async () => {
                try {
                  await api('/policies', { body: { ...add, windowHours: Number(add.windowHours), effectiveFrom: new Date(add.effectiveFrom).toISOString(), notes: add.notes || undefined } });
                  setAdd(null);
                  p.reload();
                  toast('Đã tạo phiên bản quy tắc');
                } catch (e: any) {
                  toast(e.message, 'error');
                }
              }}
            >
              Tạo
            </Button>
          }
        >
          <Notice tone="warn">Chỉ thay đổi khi nền tảng công bố chính sách mới. Ghi rõ đường dẫn tài liệu chính thức làm căn cứ.</Notice>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Kênh">
              <Select className="w-full" value={add.channelType} onChange={(e) => setAdd({ ...add, channelType: e.target.value, category: e.target.value === 'ZALO' ? 'CS' : 'RESPONSE' })}>
                <option value="FACEBOOK">Facebook</option>
                <option value="ZALO">Zalo</option>
              </Select>
            </Field>
            <Field label="Loại">
              <Select className="w-full" value={add.category} onChange={(e) => setAdd({ ...add, category: e.target.value })}>
                {add.channelType === 'FACEBOOK' ? (
                  <>
                    <option value="RESPONSE">RESPONSE (tin thường)</option>
                    <option value="HUMAN_AGENT">HUMAN_AGENT</option>
                  </>
                ) : (
                  <option value="CS">CS (tin tư vấn)</option>
                )}
              </Select>
            </Field>
            <Field label="Cửa sổ (giờ)">
              <Input type="number" value={add.windowHours} onChange={(e) => setAdd({ ...add, windowHours: e.target.value })} />
            </Field>
            <Field label="Hiệu lực từ">
              <Input type="datetime-local" value={add.effectiveFrom} onChange={(e) => setAdd({ ...add, effectiveFrom: e.target.value })} />
            </Field>
            <Field label="Người gửi được phép" className="col-span-2">
              <div className="flex gap-3 text-sm">
                {['AGENT', 'BOT', 'RULE'].map((s) => (
                  <label key={s} className="flex items-center gap-1">
                    <input type="checkbox" checked={add.allowedSenders.includes(s)} onChange={(e) => setAdd({ ...add, allowedSenders: e.target.checked ? [...add.allowedSenders, s] : add.allowedSenders.filter((x: string) => x !== s) })} />
                    {s === 'AGENT' ? 'Nhân viên' : s === 'BOT' ? 'Chatbot' : 'Quy tắc'}
                  </label>
                ))}
              </div>
            </Field>
            <Field label="URL tài liệu nguồn" className="col-span-2">
              <Input value={add.sourceUrl} onChange={(e) => setAdd({ ...add, sourceUrl: e.target.value })} />
            </Field>
            <Field label="Mức xác minh">
              <Select className="w-full" value={add.verificationStatus} onChange={(e) => setAdd({ ...add, verificationStatus: e.target.value })}>
                <option value="VERIFIED">Đã đối chiếu tài liệu chính thức</option>
                <option value="SECONDARY">Nguồn phụ</option>
              </Select>
            </Field>
            <Field label="Ghi chú" className="col-span-2">
              <Textarea rows={2} value={add.notes} onChange={(e) => setAdd({ ...add, notes: e.target.value })} />
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Ops() {
  const { can } = useSession();
  const toast = useToast();
  const hooks = useApi<{ items: any[]; counts: Record<string, number> }>('/ops/webhooks?status=FAILED');
  const out = useApi<{ items: any[] }>('/ops/outbound');
  const dlq = useApi<{ items: any[] }>('/ops/dead-letter');
  return (
    <div className="space-y-4">
      <Card title="Webhook lỗi" actions={hooks.data && <span className="text-xs text-gray-500">{Object.entries(hooks.data.counts).map(([k, v]) => `${k}: ${v}`).join(' · ')}</span>}>
        {!hooks.data ? (
          <Spinner />
        ) : !hooks.data.items.length ? (
          <Empty title="Không có webhook lỗi" />
        ) : (
          <Table head={['Nhận lúc', 'Nguồn', 'Loại', 'Lần thử', 'Lỗi', '']}>
            {hooks.data.items.map((h) => (
              <tr key={h.id}>
                <td className="whitespace-nowrap px-3 py-2 text-xs">{fmtDateTime(h.receivedAt)}</td>
                <td className="px-3 py-2">{h.provider}</td>
                <td className="px-3 py-2 text-xs">{h.eventType}</td>
                <td className="px-3 py-2">{h.attempts}</td>
                <td className="max-w-sm px-3 py-2 text-xs text-red-700">{h.error}</td>
                <td className="px-3 py-2">
                  <Button size="sm" variant="ghost" onClick={async () => { await api(`/ops/webhooks/${h.id}/retry`, { method: 'POST' }).catch((e) => toast(e.message, 'error')); hooks.reload(); }}>
                    Xử lý lại
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="Tin gửi đi cần chú ý (đang chờ / lỗi / chưa xác định / bị chặn)">
        {!out.data ? (
          <Spinner />
        ) : !out.data.items.length ? (
          <Empty title="Không có" />
        ) : (
          <Table head={['Cập nhật', 'Trạng thái', 'Người gửi', 'Nội dung', 'Lỗi', 'Lần thử', '']}>
            {out.data.items.map((o) => (
              <tr key={o.id}>
                <td className="whitespace-nowrap px-3 py-2 text-xs">{fmtDateTime(o.updatedAt)}</td>
                <td className="px-3 py-2 text-xs">{o.status}</td>
                <td className="px-3 py-2 text-xs">{o.message?.senderType}</td>
                <td className="max-w-xs truncate px-3 py-2 text-xs">{o.message?.text}</td>
                <td className="max-w-xs px-3 py-2 text-xs text-red-700">{o.message?.errorMessage ?? o.lastError}</td>
                <td className="px-3 py-2">{o.attempts}</td>
                <td className="px-3 py-2">
                  <a className="text-xs text-brand-600 underline" href={`/inbox?c=${o.message?.conversationId}`}>
                    Mở
                  </a>
                </td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-2 text-xs text-gray-500">Tin “Chưa xác định” không được tự động gửi lại vì có thể đã tới khách. Nhân viên quyết định gửi lại trong hội thoại.</p>
      </Card>
      <Card title="Hàng đợi lỗi (dead-letter)">
        {dlq.error ? (
          <ErrorBox error={dlq.error} />
        ) : !dlq.data ? (
          <Spinner />
        ) : !dlq.data.items.length ? (
          <Empty title="Không có tác vụ lỗi" />
        ) : (
          <Table head={['Thời gian', 'Hàng đợi', 'Mã', 'Lần thử', 'Lý do', '']}>
            {dlq.data.items.map((j) => (
              <tr key={`${j.queue}:${j.id}`}>
                <td className="whitespace-nowrap px-3 py-2 text-xs">{fmtDateTime(new Date(j.timestamp))}</td>
                <td className="px-3 py-2">{j.queue}</td>
                <td className="px-3 py-2 font-mono text-xs">{j.id}</td>
                <td className="px-3 py-2">{j.attemptsMade}</td>
                <td className="max-w-sm px-3 py-2 text-xs text-red-700">{j.failedReason}</td>
                <td className="px-3 py-2">
                  {can.owner && (
                    <Button size="sm" variant="ghost" onClick={async () => { await api(`/ops/dead-letter/${j.queue}/${encodeURIComponent(j.id)}/retry`, { method: 'POST' }).catch((e) => toast(e.message, 'error')); dlq.reload(); }}>
                      Chạy lại
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function Audit() {
  const [before, setBefore] = useState<string | null>(null);
  const a = useApi<{ items: any[]; users: any[] }>(`/audit-logs${before ? `?before=${encodeURIComponent(before)}` : ''}`);
  const name = (id: string | null) => (id ? a.data?.users.find((u) => u.id === id)?.name ?? id : 'Hệ thống');
  return (
    <Card title="Nhật ký thao tác">
      {a.error ? (
        <ErrorBox error={a.error} />
      ) : !a.data ? (
        <Spinner />
      ) : (
        <>
          <Table head={['Thời gian', 'Người thực hiện', 'Thao tác', 'Đối tượng', 'Chi tiết']}>
            {a.data.items.map((l) => (
              <tr key={l.id}>
                <td className="whitespace-nowrap px-3 py-2 text-xs">{fmtDateTime(l.createdAt)}</td>
                <td className="px-3 py-2">{name(l.actorId)}</td>
                <td className="px-3 py-2 font-mono text-xs">{l.action}</td>
                <td className="px-3 py-2 text-xs">{l.targetType ? `${l.targetType}:${l.targetId}` : ''}</td>
                <td className="max-w-md truncate px-3 py-2 text-xs text-gray-600" title={JSON.stringify(l.metadata)}>
                  {l.metadata ? JSON.stringify(l.metadata) : ''}
                </td>
              </tr>
            ))}
          </Table>
          {a.data.items.length === 100 && (
            <Button className="mt-3" size="sm" variant="secondary" onClick={() => setBefore(a.data!.items[99].createdAt)}>
              Cũ hơn
            </Button>
          )}
        </>
      )}
    </Card>
  );
}

function DataSecurity() {
  const { can } = useSession();
  const toast = useToast();
  return (
    <div className="space-y-4">
      {can.admin && (
        <Card title="Xuất dữ liệu">
          <p className="mb-2 text-sm text-gray-600">Xuất trong phạm vi quyền của bạn. Mỗi lần xuất được ghi nhật ký. Thời gian trong tệp ở dạng UTC.</p>
          <Button variant="secondary" onClick={() => download('/export/conversations.csv', 'hoi-thoai.csv').catch((e) => toast(e.message, 'error'))}>
            Tải danh sách hội thoại (CSV)
          </Button>
          <p className="mt-2 text-xs text-gray-500">Xoá dữ liệu của một khách hàng: vào trang Khách hàng → chọn khách → “Xoá dữ liệu khách” (Chủ sở hữu).</p>
        </Card>
      )}
      <Card title="Phiên đăng nhập">
        <Button
          variant="secondary"
          onClick={async () => {
            await api('/auth/logout-others', { method: 'POST' }).then(() => toast('Đã đăng xuất mọi phiên khác')).catch((e) => toast(e.message, 'error'));
          }}
        >
          Đăng xuất khỏi mọi thiết bị khác
        </Button>
      </Card>
    </div>
  );
}
