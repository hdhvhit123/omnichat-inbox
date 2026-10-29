'use client';
import clsx from 'clsx';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, qs } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { CONV_STATUS } from '@/lib/labels';
import { useSession } from '@/lib/session';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, Notice, PageHeader, Spinner, Textarea, useToast } from '@/components/ui';

function Customers() {
  const router = useRouter();
  const params = useSearchParams();
  const selected = params.get('id');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<any[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => {
      setLoading(true);
      api(`/customers${qs({ q })}`)
        .then((r) => {
          setItems(r.items);
          setCursor(r.nextCursor);
          setError(null);
        })
        .catch(setError)
        .finally(() => setLoading(false));
    }, 300);
    return () => clearTimeout(t);
  }, [q, version]);

  return (
    <div className="flex h-full">
      <div className="flex w-96 shrink-0 flex-col border-r bg-white">
        <div className="border-b p-3">
          <h1 className="mb-2 font-semibold">Khách hàng</h1>
          <Input placeholder="Tìm tên, SĐT, email…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Tìm khách hàng" />
        </div>
        <div className="scroll-thin flex-1 overflow-y-auto">
          {error && <div className="p-3"><ErrorBox error={error} /></div>}
          {loading && !items.length ? (
            <Spinner />
          ) : !items.length ? (
            <Empty title="Không tìm thấy khách hàng" />
          ) : (
            <ul>
              {items.map((c) => (
                <li key={c.id}>
                  <button onClick={() => router.push(`/customers?id=${c.id}`)} className={clsx('block w-full border-b px-3 py-2 text-left hover:bg-gray-50', selected === c.id && 'bg-brand-50')}>
                    <div className="text-sm font-medium">{c.displayName}</div>
                    <div className="text-xs text-gray-500">
                      {c.identities.map((i: any) => (i.channel.type === 'FACEBOOK' ? 'Facebook' : 'Zalo')).join(' · ')} · {c._count.conversations} hội thoại
                      {c.phone && ` · ${c.phone}`}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {cursor && (
            <div className="p-3 text-center">
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  api(`/customers${qs({ q, cursor })}`).then((r) => {
                    setItems((x) => [...x, ...r.items]);
                    setCursor(r.nextCursor);
                  })
                }
              >
                Tải thêm
              </Button>
            </div>
          )}
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {selected ? <CustomerDetail key={selected} id={selected} onChanged={() => setVersion((v) => v + 1)} /> : <Empty title="Chọn một khách hàng để xem hồ sơ" />}
      </div>
    </div>
  );
}

function CustomerDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { can } = useSession();
  const router = useRouter();
  const toast = useToast();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<Error | null>(null);
  const [merge, setMerge] = useState(false);
  const [del, setDel] = useState(false);
  const load = () => api(`/customers/${id}`).then(setData).catch(setError);
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  if (error) return <div className="p-6"><ErrorBox error={error} /></div>;
  if (!data) return <Spinner />;
  const c = data.customer;

  return (
    <div className="p-6">
      <PageHeader
        title={c.displayName}
        description={`Tạo lúc ${fmtDateTime(c.createdAt)}`}
        actions={
          <>
            {can.admin && (
              <Button variant="secondary" onClick={() => setMerge(true)}>
                Liên kết / gộp hồ sơ
              </Button>
            )}
            {can.owner && (
              <Button variant="danger" onClick={() => setDel(true)}>
                Xoá dữ liệu khách
              </Button>
            )}
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Thông tin">
          <dl className="space-y-1 text-sm">
            <div>SĐT: {c.phone ?? '—'}</div>
            <div>Email: {c.email ?? '—'}</div>
            <div>Ghi chú: {c.notes ?? '—'}</div>
            <div className="flex flex-wrap gap-1">Nhãn: {c.tags.length ? c.tags.map((t: any) => <Badge key={t.id}>{t.name}</Badge>) : '—'}</div>
          </dl>
          <p className="mt-2 text-xs text-gray-500">Sửa thông tin trong khung bên phải của Hộp thư.</p>
        </Card>
        <Card title="Danh tính theo kênh">
          <ul className="space-y-2 text-sm">
            {c.identities.map((i: any) => (
              <li key={i.id} className="rounded border p-2">
                <div className="font-medium">
                  {i.channel.type === 'FACEBOOK' ? 'Facebook' : 'Zalo OA'} · {i.channel.name}
                </div>
                <div className="text-xs text-gray-500">ID trên nền tảng (theo trang/OA): {i.externalUserId}</div>
                <div className="text-xs text-gray-500">Lần đầu: {fmtDateTime(i.createdAt)}</div>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Hội thoại">
          <ul className="space-y-1 text-sm">
            {c.conversations.map((o: any) => (
              <li key={o.id}>
                <Link href={`/inbox?c=${o.id}`} className="block rounded border p-2 hover:bg-gray-50">
                  <span className={`mr-1 rounded px-1 text-xs ${CONV_STATUS[o.status]?.cls}`}>{CONV_STATUS[o.status]?.label}</span>
                  {o.channel.name} · {fmtDateTime(o.lastMessageAt)}
                  <div className="truncate text-xs text-gray-500">{o.lastMessagePreview}</div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Lịch sử liên kết hồ sơ">
          {data.links.length ? (
            <ul className="space-y-1 text-sm">
              {data.links.map((l: any) => (
                <li key={l.id} className="rounded border p-2">
                  {fmtDateTime(l.createdAt)} — {l.action === 'MERGE' ? 'Gộp hồ sơ' : l.action}: {l.reason}
                  {l.evidence && <div className="text-xs text-gray-500">Căn cứ: {l.evidence}</div>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-gray-500">Chưa có. Hệ thống không bao giờ tự gộp hồ sơ dựa trên tên hoặc ảnh đại diện.</p>
          )}
        </Card>
      </div>
      <MergeModal open={merge} onClose={() => setMerge(false)} source={c} onDone={(targetId) => { setMerge(false); onChanged(); router.push(`/customers?id=${targetId}`); }} />
      <Modal
        open={del}
        onClose={() => setDel(false)}
        title="Xoá dữ liệu khách hàng"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDel(false)}>
              Huỷ
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                try {
                  await api(`/customers/${c.id}?confirm=DELETE`, { method: 'DELETE' });
                  toast('Đã xoá dữ liệu khách hàng');
                  setDel(false);
                  onChanged();
                  router.push('/customers');
                } catch (e: any) {
                  toast(e.message, 'error');
                }
              }}
            >
              Xoá vĩnh viễn
            </Button>
          </>
        }
      >
        <Notice tone="error">Xoá hồ sơ, toàn bộ hội thoại, tin nhắn và tệp đính kèm của khách này trong hệ thống. Không thể hoàn tác. Dữ liệu trên Facebook/Zalo không bị ảnh hưởng.</Notice>
      </Modal>
    </div>
  );
}

function MergeModal({ open, onClose, source, onDone }: { open: boolean; onClose: () => void; source: any; onDone: (targetId: string) => void }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [target, setTarget] = useState<any>(null);
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  useEffect(() => {
    if (!open || !q.trim()) return setResults([]);
    const t = setTimeout(() => api(`/customers${qs({ q })}`).then((r) => setResults(r.items.filter((x: any) => x.id !== source.id))), 300);
    return () => clearTimeout(t);
  }, [q, open, source.id]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Liên kết hồ sơ đa kênh"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Huỷ
          </Button>
          <Button
            disabled={!target || reason.trim().length < 5}
            onClick={async () => {
              if (!confirm(`Xác nhận gộp "${source.displayName}" vào "${target.displayName}"? Thao tác được ghi nhật ký.`)) return;
              try {
                const r = await api('/customers/merge', { body: { sourceId: source.id, targetId: target.id, reason, evidence: evidence || undefined } });
                toast('Đã gộp hồ sơ');
                onDone(r.customerId);
              } catch (e: any) {
                toast(e.message, 'error');
              }
            }}
          >
            Xác nhận gộp
          </Button>
        </>
      }
    >
      <Notice tone="warn">Chỉ gộp khi có căn cứ rõ ràng (ví dụ khách xác nhận cùng số điện thoại trên cả hai kênh). Trùng tên hoặc ảnh không phải là căn cứ.</Notice>
      <Field label="Gộp vào hồ sơ">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm theo tên, SĐT…" />
      </Field>
      <ul className="max-h-40 overflow-y-auto">
        {results.map((r) => (
          <li key={r.id}>
            <button onClick={() => setTarget(r)} className={clsx('block w-full rounded px-2 py-1 text-left text-sm hover:bg-gray-50', target?.id === r.id && 'bg-brand-50')}>
              {r.displayName} <span className="text-xs text-gray-500">{r.identities.map((i: any) => i.channel.name).join(', ')} {r.phone}</span>
            </button>
          </li>
        ))}
      </ul>
      <Field label="Lý do (bắt buộc)">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="vd. Khách xác nhận cùng SĐT trên Zalo và Facebook" />
      </Field>
      <Field label="Căn cứ">
        <Textarea rows={2} value={evidence} onChange={(e) => setEvidence(e.target.value)} />
      </Field>
    </Modal>
  );
}

export default function CustomersPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Customers />
    </Suspense>
  );
}
