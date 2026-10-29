'use client';
import { FlaskConical } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { SEND_FAIL_LABEL } from '@/lib/labels';
import { Button, Field, Input, Modal, Notice, Select, Textarea, useToast } from '@/components/ui';

/** Công cụ mô phỏng: tạo tin đến theo định dạng webhook thật và giả lập lỗi gửi. Chỉ có ở workspace demo. */
export function SimulatorPanel({ defaultChannelId, defaultUser }: { defaultChannelId?: string; defaultUser?: { externalId?: string; name?: string } }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const channels = useApi<{ items: any[] }>(open ? '/channels' : null);
  const [channelId, setChannelId] = useState(defaultChannelId ?? '');
  const [userId, setUserId] = useState(defaultUser?.externalId ?? '');
  const [name, setName] = useState(defaultUser?.name ?? '');
  const [text, setText] = useState('Cho mình hỏi giá sản phẩm với ạ');
  const [failure, setFailure] = useState('fail');
  const [busy, setBusy] = useState(false);
  const ch = channelId || channels.data?.items[0]?.id || '';

  async function sendInbound() {
    setBusy(true);
    try {
      await api('/demo/inbound', { body: { channelId: ch, userExternalId: userId || undefined, customerName: name || undefined, text } });
      toast('Đã tạo tin nhắn mô phỏng của khách');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }
  async function injectFailure() {
    try {
      await api('/demo/fail-next-send', { body: { channelId: ch, failure } });
      toast(`Lần gửi tiếp theo trên kênh này sẽ gặp: ${SEND_FAIL_LABEL[failure]}`, 'info');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <FlaskConical className="h-4 w-4" /> Mô phỏng
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Công cụ mô phỏng (Dữ liệu mô phỏng)">
        <Notice tone="warn">Tin nhắn được tạo theo định dạng webhook của nền tảng và đi qua đúng luồng xử lý thật, nhưng không có kết nối tới Facebook/Zalo. Không có tin nào được gửi ra ngoài.</Notice>
        <Field label="Kênh mô phỏng">
          <Select className="w-full" value={ch} onChange={(e) => setChannelId(e.target.value)}>
            {channels.data?.items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.type === 'FACEBOOK' ? 'Facebook' : 'Zalo'} · {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Mã người dùng (để trống = khách mới)">
            <Input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="vd. sim_user_1" />
          </Field>
          <Field label="Tên khách">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="vd. Nguyễn Văn A" />
          </Field>
        </div>
        <Field label="Nội dung khách gửi">
          <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        <Button onClick={sendInbound} loading={busy} disabled={!ch || !text.trim()}>
          Gửi tin đến
        </Button>
        <hr />
        <Field label="Giả lập lỗi cho lần gửi tiếp theo" hint="Dùng để kiểm tra trạng thái Thất bại / Chưa xác định / Token hết hạn trong hộp thư.">
          <div className="flex gap-2">
            <Select className="flex-1" value={failure} onChange={(e) => setFailure(e.target.value)}>
              {Object.entries(SEND_FAIL_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
            <Button variant="secondary" onClick={injectFailure} disabled={!ch}>
              Áp dụng
            </Button>
          </div>
        </Field>
      </Modal>
    </>
  );
}
