'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fmtDateTime, fmtRelative } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { BOT_MODE, CHANNEL_LABEL, CHANNEL_STATUS } from '@/lib/labels';
import { useSession } from '@/lib/session';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, Notice, PageHeader, Select, Spinner, useToast } from '@/components/ui';

function Channels() {
  const { ws, can } = useSession();
  const toast = useToast();
  const router = useRouter();
  const params = useSearchParams();
  const list = useApi<{ items: any[] }>('/channels');
  const [busy, setBusy] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const fbState = params.get('connect') === 'facebook' ? params.get('state') : null;
  const err = params.get('error');
  const connected = params.get('connected');

  async function connect(type: 'facebook' | 'zalo') {
    try {
      const r = await api(`/channels/${type}/connect-url`);
      window.location.href = r.url;
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }
  async function test(c: any) {
    setBusy(c.id);
    try {
      const r = await api(`/channels/${c.id}/test`, { method: 'POST' });
      toast(r.result.ok ? `Kết nối hoạt động: ${r.result.message}` : `Kiểm tra thất bại: ${r.result.message}`, r.result.ok ? 'success' : 'error');
      list.reload();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(null);
    }
  }
  async function disconnect(c: any) {
    if (!confirm(`Ngắt kết nối "${c.name}"? Token sẽ bị xoá; hội thoại cũ vẫn được giữ.`)) return;
    await api(`/channels/${c.id}/disconnect`, { method: 'POST' }).catch((e) => toast(e.message, 'error'));
    list.reload();
  }
  async function setMode(c: any, botMode: string) {
    await api(`/channels/${c.id}`, { method: 'PATCH', body: { botMode } }).catch((e) => toast(e.message, 'error'));
    list.reload();
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return (
    <div className="p-6">
      <PageHeader
        title="Kết nối kênh"
        description="Chỉ dùng API chính thức của Meta và Zalo. Kênh chỉ hiển thị “Đã kết nối” sau khi hệ thống gọi API nền tảng xác minh thành công."
        actions={
          can.owner &&
          !ws.isDemo && (
            <>
              <Button onClick={() => connect('facebook')}>Kết nối Facebook Page</Button>
              <Button onClick={() => connect('zalo')}>Kết nối Zalo OA</Button>
              <Button variant="secondary" onClick={() => setManual(true)}>
                Nhập token thủ công
              </Button>
            </>
          )
        }
      />
      {ws.isDemo && (
        <div className="mb-4">
          <Notice tone="warn">Workspace demo chỉ có kênh mô phỏng. Để kết nối Fanpage/OA thật, chuyển sang workspace thật (chọn ở góc trên bên trái).</Notice>
        </div>
      )}
      {err && (
        <div className="mb-4">
          <Notice tone="error">{err}</Notice>
        </div>
      )}
      {connected && (
        <div className="mb-4">
          <Notice tone="success">Đã kết nối và xác minh {connected === 'zalo' ? 'Zalo OA' : 'kênh'} thành công.</Notice>
        </div>
      )}
      {list.error ? (
        <ErrorBox error={list.error} onRetry={list.reload} />
      ) : list.loading && !list.data ? (
        <Spinner />
      ) : !list.data?.items.length ? (
        <Card>
          <Empty title="Chưa có kênh nào">Kết nối Fanpage hoặc Zalo OA để bắt đầu nhận tin nhắn.</Empty>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {list.data.items.map((c) => (
            <Card
              key={c.id}
              title={
                <span className="flex items-center gap-2">
                  {CHANNEL_LABEL[c.type]} · {c.name}
                  {c.isSimulated && <Badge className="bg-amber-100 text-amber-900">Mô phỏng</Badge>}
                </span>
              }
              actions={<Badge className={CHANNEL_STATUS[c.status]?.cls}>{CHANNEL_STATUS[c.status]?.label}</Badge>}
            >
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-gray-500">ID {c.type === 'FACEBOOK' ? 'Page' : 'OA'}</dt>
                <dd className="font-mono text-xs">{c.externalId}</dd>
                <dt className="text-gray-500">Webhook gần nhất</dt>
                <dd title={fmtDateTime(c.lastWebhookAt)}>{c.lastWebhookAt ? `${fmtDateTime(c.lastWebhookAt)} (${fmtRelative(c.lastWebhookAt)})` : 'Chưa nhận'}</dd>
                <dt className="text-gray-500">Gọi API thành công gần nhất</dt>
                <dd>{fmtDateTime(c.lastApiSuccessAt)}</dd>
                <dt className="text-gray-500">Xác minh gần nhất</dt>
                <dd>{fmtDateTime(c.lastVerifiedAt)}</dd>
                {c.credential?.accessTokenExpiresAt && (
                  <>
                    <dt className="text-gray-500">Access token hết hạn</dt>
                    <dd>{fmtDateTime(c.credential.accessTokenExpiresAt)} (tự làm mới)</dd>
                  </>
                )}
                {c.credential?.refreshTokenExpiresAt && (
                  <>
                    <dt className="text-gray-500">Refresh token hết hạn</dt>
                    <dd>{fmtDateTime(c.credential.refreshTokenExpiresAt)}</dd>
                  </>
                )}
                <dt className="text-gray-500">Lỗi gần nhất</dt>
                <dd className={c.lastError ? 'text-red-700' : ''}>
                  {c.lastError ? (
                    <>
                      {c.lastError}
                      {c.lastErrorCode && <span className="ml-1 font-mono text-xs">[{c.lastErrorCode}]</span>}
                      <div className="text-xs text-gray-500">{fmtDateTime(c.lastErrorAt)}</div>
                    </>
                  ) : (
                    'Không có'
                  )}
                </dd>
                <dt className="text-gray-500">Chế độ chatbot</dt>
                <dd>
                  <Select className="h-8" disabled={!can.admin} value={c.botMode} onChange={(e) => setMode(c, e.target.value)}>
                    {Object.entries(BOT_MODE).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </Select>
                </dd>
              </dl>
              {can.admin && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" loading={busy === c.id} onClick={() => test(c)}>
                    Kiểm tra kết nối
                  </Button>
                  {can.owner && !c.isSimulated && (
                    <Button size="sm" variant="secondary" onClick={() => connect(c.type === 'FACEBOOK' ? 'facebook' : 'zalo')}>
                      Cấp quyền lại
                    </Button>
                  )}
                  {can.owner && c.status !== 'DISCONNECTED' && (
                    <Button size="sm" variant="ghost" className="text-red-600" onClick={() => disconnect(c)}>
                      Ngắt kết nối
                    </Button>
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {!ws.isDemo && can.admin && (
        <Card title="Địa chỉ webhook cần khai báo" className="mt-6">
          <div className="space-y-1 text-sm">
            <div>
              Facebook (Meta App → Webhooks → Page): <code className="rounded bg-gray-100 px-1">{origin}/api/webhooks/facebook</code>
            </div>
            <div>
              Zalo (Zalo for Developers → Webhook): <code className="rounded bg-gray-100 px-1">{origin}/api/webhooks/zalo</code>
            </div>
            <p className="text-xs text-gray-500">Cần tên miền HTTPS công khai. Xem hướng dẫn chi tiết trong docs/META_SETUP.md và docs/ZALO_SETUP.md.</p>
          </div>
        </Card>
      )}

      {fbState && <FbPagePicker state={fbState} onDone={() => { router.replace('/channels'); list.reload(); }} />}
      {manual && <ManualToken onClose={() => setManual(false)} onDone={() => { setManual(false); list.reload(); }} />}
    </div>
  );
}

function FbPagePicker({ state, onDone }: { state: string; onDone: () => void }) {
  const toast = useToast();
  const [pages, setPages] = useState<any[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [sel, setSel] = useState<string[]>([]);
  const [results, setResults] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api(`/channels/facebook/pages?state=${encodeURIComponent(state)}`).then((r) => setPages(r.items)).catch(setError);
  }, [state]);
  async function submit() {
    setBusy(true);
    try {
      const r = await api('/channels/facebook/pages', { body: { state, pageIds: sel } });
      setResults(r.results);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onDone} title="Chọn Fanpage để kết nối" footer={results ? <Button onClick={onDone}>Xong</Button> : <Button onClick={submit} loading={busy} disabled={!sel.length}>Kết nối {sel.length} trang</Button>}>
      {error && <ErrorBox error={error} />}
      {!pages && !error && <Spinner />}
      {results ? (
        <ul className="space-y-1 text-sm">
          {results.map((r) => (
            <li key={r.pageId} className={r.ok ? 'text-green-700' : 'text-red-700'}>
              {r.ok ? '✓' : '✗'} {r.name}: {r.message}
            </li>
          ))}
        </ul>
      ) : (
        pages && (
          <ul className="space-y-1">
            {pages.map((p) => (
              <li key={p.id}>
                <label className="flex items-center gap-2 rounded border p-2 text-sm">
                  <input type="checkbox" disabled={!p.canMessage} checked={sel.includes(p.id)} onChange={(e) => setSel(e.target.checked ? [...sel, p.id] : sel.filter((x) => x !== p.id))} />
                  <span className="flex-1">{p.name}</span>
                  {!p.canMessage && <span className="text-xs text-red-600">Tài khoản không có quyền nhắn tin trên trang này</span>}
                </label>
              </li>
            ))}
            {!pages.length && <p className="text-sm text-gray-500">Không có trang nào được cấp quyền. Hãy chọn trang trong hộp thoại Facebook.</p>}
          </ul>
        )
      )}
    </Modal>
  );
}

function ManualToken({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ type: 'FACEBOOK', externalId: '', name: '', accessToken: '', refreshToken: '' });
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      const r = await api('/channels/manual', { body: { ...f, refreshToken: f.refreshToken || undefined, name: f.name || undefined } });
      toast(r.result.ok ? 'Đã xác minh và kết nối' : `Đã lưu nhưng xác minh thất bại: ${r.result.message}`, r.result.ok ? 'success' : 'error');
      onDone();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onClose} title="Nhập token thủ công" footer={<Button onClick={submit} loading={busy}>Lưu và xác minh</Button>}>
      <Notice tone="info">Dùng khi bạn đã có Page Access Token (tạo trong Meta App Dashboard) hoặc token Zalo OA. Token được mã hoá khi lưu và không bao giờ hiển thị lại.</Notice>
      <Field label="Loại kênh">
        <Select className="w-full" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
          <option value="FACEBOOK">Facebook Page</option>
          <option value="ZALO">Zalo OA</option>
        </Select>
      </Field>
      <Field label={f.type === 'FACEBOOK' ? 'Page ID' : 'OA ID'}>
        <Input value={f.externalId} onChange={(e) => setF({ ...f, externalId: e.target.value })} />
      </Field>
      <Field label="Tên hiển thị (tuỳ chọn)">
        <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </Field>
      <Field label="Access token">
        <Input type="password" autoComplete="off" value={f.accessToken} onChange={(e) => setF({ ...f, accessToken: e.target.value })} />
      </Field>
      {f.type === 'ZALO' && (
        <Field label="Refresh token">
          <Input type="password" autoComplete="off" value={f.refreshToken} onChange={(e) => setF({ ...f, refreshToken: e.target.value })} />
        </Field>
      )}
    </Modal>
  );
}

export default function ChannelsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Channels />
    </Suspense>
  );
}
