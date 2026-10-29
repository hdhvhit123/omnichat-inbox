'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { CONV_STATUS } from '@/lib/labels';
import { useSession } from '@/lib/session';
import { Badge, Button, Field, Input, Select, Spinner, Textarea, useToast } from '@/components/ui';
import type { Tag } from './types';

export function CustomerPanel({ conversationId, tags }: { conversationId: string; tags: Tag[] }) {
  const { can } = useSession();
  const toast = useToast();
  const [conv, setConv] = useState<any>(null);
  const [form, setForm] = useState({ displayName: '', phone: '', email: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [other, setOther] = useState<any[]>([]);

  const load = () =>
    api(`/conversations/${conversationId}`).then((c) => {
      setConv(c);
      setForm({ displayName: c.customer.displayName ?? '', phone: c.customer.phone ?? '', email: c.customer.email ?? '', notes: c.customer.notes ?? '' });
      api(`/customers/${c.customer.id}`).then((r) => setOther(r.customer.conversations.filter((x: any) => x.id !== conversationId))).catch(() => setOther([]));
    });
  useEffect(() => {
    setConv(null);
    load().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  if (!conv) return <Spinner />;
  const c = conv.customer;

  async function save() {
    setSaving(true);
    try {
      await api(`/customers/${c.id}`, { method: 'PATCH', body: { displayName: form.displayName, phone: form.phone || undefined, email: form.email || undefined, notes: form.notes } });
      toast('Đã lưu thông tin khách hàng');
      load();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  }
  async function addTag(tagId: string) {
    if (!tagId) return;
    await api(`/conversations/${conversationId}/tags`, { body: { tagId } }).catch((e) => toast(e.message, 'error'));
    load();
  }
  async function removeTag(tagId: string) {
    await api(`/conversations/${conversationId}/tags/${tagId}`, { method: 'DELETE' }).catch((e) => toast(e.message, 'error'));
    load();
  }

  return (
    <div className="scroll-thin h-full space-y-4 overflow-y-auto p-4 text-sm">
      <div>
        <div className="text-base font-semibold">{c.displayName}</div>
        <Link href={`/customers?id=${c.id}`} className="text-xs text-brand-600 hover:underline">
          Xem hồ sơ khách hàng
        </Link>
      </div>
      <div className="space-y-2">
        <Field label="Tên hiển thị">
          <Input disabled={!can.write} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
        </Field>
        <Field label="Số điện thoại">
          <Input disabled={!can.write} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="09xx xxx xxx" />
        </Field>
        <Field label="Email">
          <Input disabled={!can.write} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Ghi chú về khách">
          <Textarea disabled={!can.write} rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field>
        {can.write && (
          <Button size="sm" onClick={save} loading={saving}>
            Lưu
          </Button>
        )}
      </div>

      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase text-gray-500">Nhãn hội thoại</h3>
        <div className="flex flex-wrap gap-1">
          {conv.tags.map((t: Tag) => (
            <Badge key={t.id} className="bg-gray-100 text-gray-800">
              {t.name}
              {can.write && (
                <button aria-label={`Bỏ nhãn ${t.name}`} onClick={() => removeTag(t.id)} className="text-gray-500 hover:text-red-600">
                  ×
                </button>
              )}
            </Badge>
          ))}
          {!conv.tags.length && <span className="text-xs text-gray-400">Chưa có nhãn</span>}
        </div>
        {can.write && (
          <Select className="mt-2 w-full" value="" onChange={(e) => addTag(e.target.value)} aria-label="Thêm nhãn">
            <option value="">+ Thêm nhãn…</option>
            {tags.filter((t) => !conv.tags.some((x: Tag) => x.id === t.id)).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        )}
      </div>

      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase text-gray-500">Danh tính theo kênh</h3>
        <ul className="space-y-1">
          {c.identities.map((i: any) => (
            <li key={i.id} className="rounded border p-2 text-xs">
              <div className="font-medium">
                {i.channel.type === 'FACEBOOK' ? 'Facebook' : 'Zalo'} · {i.channel.name}
              </div>
              <div className="text-gray-500">ID: {i.externalUserId}</div>
              {!i.canReceive && <div className="text-red-600">Không nhận được tin{i.cannotReceiveReason ? `: ${i.cannotReceiveReason}` : ''}</div>}
            </li>
          ))}
        </ul>
        <p className="mt-1 text-xs text-gray-500">Hồ sơ không tự gộp theo tên hay ảnh. Liên kết đa kênh thực hiện thủ công ở trang Khách hàng.</p>
      </div>

      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase text-gray-500">Thông tin hội thoại</h3>
        <dl className="space-y-0.5 text-xs text-gray-600">
          <div>Tin đầu của khách: {fmtDateTime(conv.firstInboundAt)}</div>
          <div>Tin gần nhất của khách: {fmtDateTime(conv.lastInboundAt)}</div>
          {conv.handoffAt && <div>Chuyển nhân viên lúc: {fmtDateTime(conv.handoffAt)}</div>}
          {conv.flowState?.type === 'lead' && <div>Đang thu thập thông tin (bước: {({ name: 'tên', phone: 'số điện thoại', need: 'nhu cầu' } as Record<string, string>)[conv.flowState.step]})</div>}
        </dl>
      </div>

      {other.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase text-gray-500">Hội thoại khác của khách</h3>
          <ul className="space-y-1">
            {other.map((o) => (
              <li key={o.id}>
                <Link href={`/inbox?c=${o.id}`} className="block rounded border p-2 text-xs hover:bg-gray-50">
                  <span className={`mr-1 rounded px-1 ${CONV_STATUS[o.status]?.cls}`}>{CONV_STATUS[o.status]?.label}</span>
                  {o.channel.name} — {o.lastMessagePreview}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
