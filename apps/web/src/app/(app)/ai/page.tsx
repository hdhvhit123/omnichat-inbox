'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fmtDateTime, fmtUsd } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { DOC_STATUS } from '@/lib/labels';
import { useSession } from '@/lib/session';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, Notice, PageHeader, Select, Spinner, Table, Textarea, Toggle, useToast } from '@/components/ui';

export default function AiPage() {
  const { can } = useSession();
  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Chatbot & kho kiến thức"
        description={
          <>
            Chatbot chỉ trả lời dựa trên tài liệu <b>đã duyệt</b>. Không có thông tin phù hợp, khách muốn gặp người, khiếu nại, lỗi AI/API hoặc vượt ngân sách → chuyển nhân viên. Chế độ (Thủ công / Trợ lý / Tự động) đặt theo từng kênh ở trang{' '}
            <Link href="/channels" className="text-brand-600 underline">
              Kết nối kênh
            </Link>{' '}
            hoặc theo từng hội thoại.
          </>
        }
      />
      {can.admin && <AiSettings />}
      <Knowledge />
      <RetrievalTester />
    </div>
  );
}

function AiSettings() {
  const { can } = useSession();
  const toast = useToast();
  const s = useApi<any>('/ai/settings');
  const [f, setF] = useState<any>(null);
  const [apiKey, setApiKey] = useState('');
  useEffect(() => {
    if (s.data) setF({ ...s.data.settings, handoffKeywords: (s.data.settings.handoffKeywords ?? []).join(', ') });
  }, [s.data]);
  if (s.error) return <ErrorBox error={s.error} onRetry={s.reload} />;
  if (!f) return <Spinner />;
  const editable = can.admin;

  async function save(clearApiKey = false) {
    try {
      await api('/ai/settings', {
        method: 'PUT',
        body: {
          provider: f.provider,
          model: f.model,
          baseUrl: f.baseUrl || null,
          apiKey: apiKey || undefined,
          clearApiKey: clearApiKey || undefined,
          maxOutputTokens: Number(f.maxOutputTokens),
          dailyBudgetUsd: Number(f.dailyBudgetUsd),
          monthlyBudgetUsd: Number(f.monthlyBudgetUsd),
          inputPricePerMTok: Number(f.inputPricePerMTok),
          outputPricePerMTok: Number(f.outputPricePerMTok),
          handoffKeywords: String(f.handoffKeywords).split(',').map((x: string) => x.trim()).filter(Boolean),
        },
      });
      setApiKey('');
      s.reload();
      toast('Đã lưu cấu hình AI');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }
  const sp = s.data.spend;
  return (
    <Card title="Cấu hình AI và ngân sách">
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="rounded border p-3">
          <div className="text-xs text-gray-500">Chi phí hôm nay</div>
          <div className="text-lg font-semibold">
            {fmtUsd(sp.dayUsd)} <span className="text-xs font-normal text-gray-500">/ {fmtUsd(Number(f.dailyBudgetUsd))}</span>
          </div>
        </div>
        <div className="rounded border p-3">
          <div className="text-xs text-gray-500">Chi phí tháng này</div>
          <div className="text-lg font-semibold">
            {fmtUsd(sp.monthUsd)} <span className="text-xs font-normal text-gray-500">/ {fmtUsd(Number(f.monthlyBudgetUsd))}</span>
          </div>
        </div>
        <div className="rounded border p-3">
          <div className="text-xs text-gray-500">Token hôm nay (vào/ra)</div>
          <div className="text-lg font-semibold">
            {sp.dayTokens.input.toLocaleString('vi-VN')} / {sp.dayTokens.output.toLocaleString('vi-VN')}
          </div>
        </div>
        <div className="rounded border p-3">
          <div className="text-xs text-gray-500">Token tháng (vào/ra)</div>
          <div className="text-lg font-semibold">
            {sp.monthTokens.input.toLocaleString('vi-VN')} / {sp.monthTokens.output.toLocaleString('vi-VN')}
          </div>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Nhà cung cấp">
          <Select className="w-full" disabled={!editable} value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })}>
            <option value="mock">Mô phỏng (không gọi API, dùng để thử)</option>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">Tương thích OpenAI</option>
          </Select>
        </Field>
        <Field label="Model" hint={f.provider === 'anthropic' ? 'Ví dụ: claude-opus-5-5' : undefined}>
          <Input disabled={!editable} value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} />
        </Field>
        {f.provider === 'openai' && (
          <Field label="Base URL">
            <Input disabled={!editable} value={f.baseUrl ?? ''} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} placeholder="https://…/v1" />
          </Field>
        )}
        {f.provider !== 'mock' && (
          <Field label="API key" hint={f.hasApiKey ? 'Đã lưu (mã hoá). Nhập mới để thay.' : 'Chưa có. Khoá được mã hoá và không bao giờ hiển thị lại.'}>
            <div className="flex gap-2">
              <Input type="password" autoComplete="off" disabled={!editable} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={f.hasApiKey ? '••••••••' : ''} />
              {f.hasApiKey && editable && (
                <Button variant="ghost" size="sm" onClick={() => save(true)}>
                  Xoá
                </Button>
              )}
            </div>
          </Field>
        )}
        <Field label="Giới hạn token đầu ra mỗi câu trả lời">
          <Input type="number" disabled={!editable} value={f.maxOutputTokens} onChange={(e) => setF({ ...f, maxOutputTokens: e.target.value })} />
        </Field>
        <Field label="Ngân sách ngày (USD)">
          <Input type="number" step="0.01" disabled={!editable} value={f.dailyBudgetUsd} onChange={(e) => setF({ ...f, dailyBudgetUsd: e.target.value })} />
        </Field>
        <Field label="Ngân sách tháng (USD)">
          <Input type="number" step="0.01" disabled={!editable} value={f.monthlyBudgetUsd} onChange={(e) => setF({ ...f, monthlyBudgetUsd: e.target.value })} />
        </Field>
        <Field label="Đơn giá đầu vào (USD / 1 triệu token)" hint="Nhập theo bảng giá của nhà cung cấp để ước tính chi phí">
          <Input type="number" step="0.01" disabled={!editable} value={f.inputPricePerMTok} onChange={(e) => setF({ ...f, inputPricePerMTok: e.target.value })} />
        </Field>
        <Field label="Đơn giá đầu ra (USD / 1 triệu token)">
          <Input type="number" step="0.01" disabled={!editable} value={f.outputPricePerMTok} onChange={(e) => setF({ ...f, outputPricePerMTok: e.target.value })} />
        </Field>
        <Field label="Từ khoá buộc chuyển nhân viên (bổ sung)" hint="Mặc định đã có: gặp nhân viên, người thật, khiếu nại, hoàn tiền…" className="md:col-span-3">
          <Input disabled={!editable} value={f.handoffKeywords} onChange={(e) => setF({ ...f, handoffKeywords: e.target.value })} />
        </Field>
      </div>
      {editable && (
        <Button className="mt-3" onClick={() => save()}>
          Lưu cấu hình
        </Button>
      )}
      <p className="mt-2 text-xs text-gray-500">Chỉ nội dung cần thiết (tin gần nhất của khách và đoạn tài liệu liên quan) được gửi tới nhà cung cấp AI. Không gửi SĐT, email hay ghi chú nội bộ.</p>
    </Card>
  );
}

function Knowledge() {
  const { can } = useSession();
  const toast = useToast();
  const docs = useApi<{ items: any[] }>('/knowledge');
  const [add, setAdd] = useState(false);
  const [view, setView] = useState<string | null>(null);
  useEffect(() => {
    // Tự làm mới khi còn tài liệu đang xử lý
    if (!docs.data?.items.some((d) => d.status === 'PENDING' || d.status === 'PROCESSING')) return;
    const t = setTimeout(docs.reload, 2500);
    return () => clearTimeout(t);
  }, [docs.data, docs.reload]);

  async function act(path: string, body?: unknown, method?: string) {
    try {
      await api(path, { body, method });
      docs.reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }

  return (
    <Card title="Kho kiến thức" actions={can.admin && <Button size="sm" onClick={() => setAdd(true)}>Thêm tài liệu</Button>}>
      {docs.error ? (
        <ErrorBox error={docs.error} onRetry={docs.reload} />
      ) : docs.loading && !docs.data ? (
        <Spinner />
      ) : !docs.data?.items.length ? (
        <Empty title="Chưa có tài liệu">Thêm FAQ, văn bản, PDF hoặc DOCX rồi duyệt để chatbot sử dụng.</Empty>
      ) : (
        <Table head={['Tài liệu', 'Loại', 'Phiên bản', 'Trạng thái', 'Đã duyệt', 'Cập nhật', '']}>
          {docs.data.items.map((d) => (
            <tr key={d.id}>
              <td className="px-3 py-2">
                <button className="font-medium text-brand-700 hover:underline" onClick={() => setView(d.id)}>
                  {d.title}
                </button>
                <div className="text-xs text-gray-500">{d._count.chunks} đoạn</div>
                {d.error && <div className="text-xs text-red-600">{d.error}</div>}
              </td>
              <td className="px-3 py-2">{d.sourceType}</td>
              <td className="px-3 py-2">v{d.version}</td>
              <td className="px-3 py-2">
                <Badge className={DOC_STATUS[d.status]?.cls}>{DOC_STATUS[d.status]?.label}</Badge>
              </td>
              <td className="px-3 py-2">
                <Toggle label="Duyệt" checked={d.approved} disabled={!can.admin || d.status !== 'READY'} onChange={(v) => act(`/knowledge/${d.id}/approve`, { approved: v })} />
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-xs">{fmtDateTime(d.updatedAt)}</td>
              <td className="whitespace-nowrap px-3 py-2 text-right">
                {can.admin && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => act(`/knowledge/${d.id}/reprocess`, {})}>
                      Xử lý lại
                    </Button>
                    <Button size="sm" variant="ghost" className="text-red-600" onClick={() => confirm(`Xoá "${d.title}" v${d.version}?`) && act(`/knowledge/${d.id}`, undefined, 'DELETE')}>
                      Xoá
                    </Button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      <p className="mt-2 text-xs text-gray-500">Duyệt một phiên bản sẽ tự lưu trữ các phiên bản khác của cùng tài liệu. Chỉ tài liệu Sẵn sàng + Đã duyệt được chatbot dùng.</p>
      {add && <AddDoc onClose={() => setAdd(false)} onDone={() => { setAdd(false); docs.reload(); }} docs={docs.data?.items ?? []} />}
      {view && <ViewDoc id={view} onClose={() => setView(null)} />}
    </Card>
  );
}

function AddDoc({ onClose, onDone, docs }: { onClose: () => void; onDone: () => void; docs: any[] }) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [sourceType, setSourceType] = useState('FAQ');
  const [rawText, setRawText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [groupId, setGroupId] = useState('');
  const [busy, setBusy] = useState(false);
  const groups = [...new Map(docs.map((d) => [d.groupId, d])).values()];

  async function submit() {
    setBusy(true);
    try {
      let fileId: string | undefined;
      if (sourceType === 'PDF' || sourceType === 'DOCX') {
        if (!file) throw new Error('Chọn tệp');
        const form = new FormData();
        form.append('file', file);
        fileId = (await api('/files', { form })).file.id;
      }
      await api('/knowledge', { body: { title, sourceType, rawText: rawText || undefined, fileId, groupId: groupId || undefined } });
      toast('Đã thêm. Tài liệu đang được xử lý; duyệt khi trạng thái là Sẵn sàng.');
      onDone();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onClose} title="Thêm tài liệu" wide footer={<><Button variant="secondary" onClick={onClose}>Huỷ</Button><Button onClick={submit} loading={busy} disabled={!title.trim()}>Thêm</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Tiêu đề">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Loại">
          <Select className="w-full" value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
            <option value="FAQ">FAQ (Hỏi: … / Đáp: …)</option>
            <option value="TEXT">Văn bản</option>
            <option value="PDF">PDF</option>
            <option value="DOCX">DOCX</option>
          </Select>
        </Field>
        <Field label="Là phiên bản mới của" className="col-span-2">
          <Select className="w-full" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">— Tài liệu mới —</option>
            {groups.map((g) => (
              <option key={g.groupId} value={g.groupId}>
                {g.title}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {sourceType === 'FAQ' || sourceType === 'TEXT' ? (
        <Field label="Nội dung" hint={sourceType === 'FAQ' ? 'Mỗi cặp: dòng "Hỏi: …" và dòng "Đáp: …", cách nhau một dòng trống.' : undefined}>
          <Textarea rows={10} value={rawText} onChange={(e) => setRawText(e.target.value)} />
        </Field>
      ) : (
        <Field label="Tệp">
          <input type="file" accept={sourceType === 'PDF' ? 'application/pdf' : '.docx'} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
      )}
      <Notice tone="info">Nội dung tài liệu được coi là dữ liệu tham khảo; mọi câu lệnh nằm trong tài liệu sẽ bị bỏ qua.</Notice>
    </Modal>
  );
}

function ViewDoc({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useApi<{ document: any }>(`/knowledge/${id}`);
  return (
    <Modal open onClose={onClose} title={d.data ? `${d.data.document.title} (v${d.data.document.version})` : 'Tài liệu'} wide>
      {d.loading ? (
        <Spinner />
      ) : (
        <ol className="space-y-2">
          {d.data?.document.chunks.map((c: any) => (
            <li key={c.id} className="whitespace-pre-wrap rounded border p-2 text-sm">
              <span className="mr-1 text-xs text-gray-400">#{c.ordinal + 1}</span>
              {c.content}
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}

function RetrievalTester() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<any[] | null>(null);
  return (
    <Card title="Thử truy xuất kiến thức">
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setRes((await api('/knowledge/search', { body: { q } })).items);
        }}
      >
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nhập câu hỏi của khách để xem đoạn tài liệu nào sẽ được dùng" />
        <Button type="submit" variant="secondary">
          Tìm
        </Button>
      </form>
      {res && (res.length ? (
        <ul className="mt-3 space-y-2">
          {res.map((r) => (
            <li key={r.chunkId} className="rounded border p-2 text-sm">
              <div className="text-xs font-medium text-gray-500">
                {r.title} (v{r.version})
              </div>
              <div className="whitespace-pre-wrap">{r.content}</div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-orange-700">Không có đoạn tài liệu phù hợp → chatbot sẽ chuyển nhân viên.</p>
      ))}
    </Card>
  );
}
