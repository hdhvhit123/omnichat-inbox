'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { ROLE_LABEL } from '@/lib/labels';
import { useSession } from '@/lib/session';
import { Button, Card, ErrorBox, Field, Input, Modal, Notice, PageHeader, Select, Spinner, Table, useToast } from '@/components/ui';

const ROLE_DESC: Record<string, string> = {
  OWNER: 'Toàn quyền: kết nối/ngắt kênh, phân quyền, chính sách gửi, xoá dữ liệu.',
  MANAGER: 'Quản lý hội thoại mọi kênh, phân công, quy tắc, chatbot, báo cáo.',
  AGENT: 'Trả lời hội thoại thuộc kênh được cấp hoặc được giao cho mình.',
  VIEWER: 'Chỉ xem hội thoại và báo cáo, không gửi tin.',
};

export default function MembersPage() {
  const { can, user } = useSession();
  const toast = useToast();
  const members = useApi<{ items: any[] }>('/members');
  const channels = useApi<{ items: any[] }>('/channels');
  const [invite, setInvite] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const [temp, setTemp] = useState<string | null>(null);

  async function save(m: any) {
    try {
      await api(`/members/${m.id}`, { method: 'PATCH', body: { role: m.role, channelIds: m.channelIds } });
      setEdit(null);
      members.reload();
      toast('Đã cập nhật quyền');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }
  const chName = (id: string) => channels.data?.items.find((c) => c.id === id)?.name ?? id;

  return (
    <div className="p-6">
      <PageHeader title="Nhân viên & phân quyền" description="Quyền được kiểm tra ở máy chủ cho mọi thao tác: API, realtime, tìm kiếm, xuất dữ liệu và tải tệp." actions={can.owner && <Button onClick={() => setInvite(true)}>Thêm thành viên</Button>} />
      <div className="mb-4 grid gap-2 md:grid-cols-4">
        {Object.entries(ROLE_DESC).map(([k, v]) => (
          <div key={k} className="rounded border bg-white p-3 text-xs">
            <div className="mb-1 text-sm font-semibold">{ROLE_LABEL[k]}</div>
            {v}
          </div>
        ))}
      </div>
      <Card>
        {members.error ? (
          <ErrorBox error={members.error} onRetry={members.reload} />
        ) : members.loading ? (
          <Spinner />
        ) : (
          <Table head={['Tên', 'Email', 'Vai trò', 'Kênh được cấp', '']}>
            {members.data?.items.map((m) => (
              <tr key={m.id}>
                <td className="px-3 py-2 font-medium">
                  {m.user.name}
                  {m.user.id === user.id && ' (bạn)'}
                </td>
                <td className="px-3 py-2">{m.user.email}</td>
                <td className="px-3 py-2">{ROLE_LABEL[m.role]}</td>
                <td className="px-3 py-2 text-xs">{m.role === 'AGENT' ? (m.channelIds.length ? m.channelIds.map(chName).join(', ') : 'Chỉ hội thoại được giao') : 'Tất cả'}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  {can.owner && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setEdit({ ...m })}>
                        Sửa quyền
                      </Button>
                      {m.user.id !== user.id && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-red-600"
                          onClick={async () => {
                            if (!confirm(`Xoá ${m.user.name} khỏi workspace?`)) return;
                            await api(`/members/${m.id}`, { method: 'DELETE' }).catch((e) => toast(e.message, 'error'));
                            members.reload();
                          }}
                        >
                          Xoá
                        </Button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {edit && (
        <Modal open onClose={() => setEdit(null)} title={`Quyền của ${edit.user.name}`} footer={<Button onClick={() => save(edit)}>Lưu</Button>}>
          <Field label="Vai trò">
            <Select className="w-full" value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })}>
              {Object.entries(ROLE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          {edit.role === 'AGENT' && (
            <ChannelPicker channels={channels.data?.items ?? []} value={edit.channelIds} onChange={(channelIds) => setEdit({ ...edit, channelIds })} />
          )}
        </Modal>
      )}
      {invite && <Invite channels={channels.data?.items ?? []} onClose={() => setInvite(false)} onDone={(t) => { setInvite(false); setTemp(t); members.reload(); }} />}
      <Modal open={!!temp} onClose={() => setTemp(null)} title="Mật khẩu tạm thời">
        <Notice tone="warn">Chỉ hiển thị một lần. Gửi cho nhân viên qua kênh an toàn và yêu cầu đổi sau khi đăng nhập.</Notice>
        <code className="block rounded bg-gray-100 p-3 text-center font-mono text-lg">{temp}</code>
      </Modal>
    </div>
  );
}

function ChannelPicker({ channels, value, onChange }: { channels: any[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <Field label="Kênh được cấp" hint="Nhân viên thấy mọi hội thoại của kênh được cấp, cộng với hội thoại được giao trực tiếp.">
      <div className="space-y-1">
        {channels.map((c) => (
          <label key={c.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={value.includes(c.id)} onChange={(e) => onChange(e.target.checked ? [...value, c.id] : value.filter((x) => x !== c.id))} />
            {c.type === 'FACEBOOK' ? 'Facebook' : 'Zalo'} · {c.name}
          </label>
        ))}
      </div>
    </Field>
  );
}

function Invite({ channels, onClose, onDone }: { channels: any[]; onClose: () => void; onDone: (temp: string | null) => void }) {
  const toast = useToast();
  const [f, setF] = useState({ email: '', name: '', role: 'AGENT', channelIds: [] as string[] });
  return (
    <Modal
      open
      onClose={onClose}
      title="Thêm thành viên"
      footer={
        <Button
          onClick={async () => {
            try {
              const r = await api('/members', { body: f });
              toast('Đã thêm thành viên');
              onDone(r.tempPassword);
            } catch (e: any) {
              toast(e.message, 'error');
            }
          }}
        >
          Thêm
        </Button>
      }
    >
      <Field label="Email">
        <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
      </Field>
      <Field label="Họ tên">
        <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </Field>
      <Field label="Vai trò">
        <Select className="w-full" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
          {Object.entries(ROLE_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
      </Field>
      {f.role === 'AGENT' && <ChannelPicker channels={channels} value={f.channelIds} onChange={(channelIds) => setF({ ...f, channelIds })} />}
    </Modal>
  );
}
