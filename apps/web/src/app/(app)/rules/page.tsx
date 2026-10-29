'use client';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { ACTION_LABEL, TRIGGER_LABEL } from '@/lib/labels';
import { useSession } from '@/lib/session';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, Notice, PageHeader, Select, Spinner, Table, Textarea, Toggle, useToast } from '@/components/ui';

type Action = { type: string; text?: string; tagName?: string; userId?: string; reason?: string; status?: string };
type Rule = {
  id?: string;
  name: string;
  enabled: boolean;
  testMode: boolean;
  trigger: string;
  channelTypes: string[];
  channelIds: string[];
  priority: number;
  conditions: { keywords?: string[]; match?: 'any' | 'all'; excludeKeywords?: string[]; intents?: string[] };
  actions: Action[];
  isGreeting: boolean;
  cooldownSeconds: number;
  maxRunsPerConversation: number | null;
};
const EMPTY: Rule = { name: '', enabled: false, testMode: true, trigger: 'INBOUND_MESSAGE', channelTypes: [], channelIds: [], priority: 100, conditions: { keywords: [], match: 'any' }, actions: [{ type: 'SEND_TEXT', text: '' }], isGreeting: false, cooldownSeconds: 0, maxRunsPerConversation: null };
const EXEC_LABEL: Record<string, string> = { EXECUTED: 'Đã chạy', DRY_RUN: 'Chế độ thử', SKIPPED: 'Bỏ qua', FAILED: 'Lỗi' };

export default function RulesPage() {
  const { can } = useSession();
  const toast = useToast();
  const list = useApi<{ items: Rule[]; intents: { key: string; label: string }[] }>('/rules');
  const members = useApi<{ items: any[] }>('/members');
  const [edit, setEdit] = useState<Rule | null>(null);
  const [execFor, setExecFor] = useState<Rule | null>(null);

  async function patch(r: Rule, data: Partial<Rule>) {
    try {
      await api(`/rules/${r.id}`, { method: 'PATCH', body: data });
      list.reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }
  async function save() {
    if (!edit) return;
    try {
      const { id, ...body } = edit;
      if (id) await api(`/rules/${id}`, { method: 'PATCH', body });
      else await api('/rules', { body });
      setEdit(null);
      list.reload();
      toast('Đã lưu quy tắc');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }

  return (
    <div className="p-6">
      <PageHeader
        title="Quy tắc tự động"
        description="Quy tắc chạy theo thứ tự ưu tiên (số nhỏ chạy trước). Mỗi tin của khách chỉ nhận tối đa một câu trả lời tự động; lời chào chỉ gửi một lần mỗi hội thoại. Quy tắc mới mặc định ở chế độ thử: ghi lịch sử nhưng không gửi."
        actions={can.admin && <Button onClick={() => setEdit(structuredClone(EMPTY))}><Plus className="h-4 w-4" /> Thêm quy tắc</Button>}
      />
      <Card>
        {list.error ? (
          <ErrorBox error={list.error} onRetry={list.reload} />
        ) : list.loading ? (
          <Spinner />
        ) : !list.data?.items.length ? (
          <Empty title="Chưa có quy tắc" />
        ) : (
          <Table head={['Ưu tiên', 'Tên', 'Kích hoạt khi', 'Hành động', 'Bật', 'Chế độ thử', '']}>
            {list.data.items.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2">{r.priority}</td>
                <td className="px-3 py-2">
                  <div className="font-medium">{r.name}</div>
                  <div className="text-xs text-gray-500">
                    {r.isGreeting && 'Lời chào · '}
                    {r.channelTypes.length ? r.channelTypes.map((t) => (t === 'FACEBOOK' ? 'Facebook' : 'Zalo')).join(', ') : 'Mọi kênh'}
                    {r.cooldownSeconds ? ` · nghỉ ${Math.round(r.cooldownSeconds / 60)} phút` : ''}
                    {r.maxRunsPerConversation ? ` · tối đa ${r.maxRunsPerConversation} lần/hội thoại` : ''}
                  </div>
                </td>
                <td className="px-3 py-2 text-xs">
                  {TRIGGER_LABEL[r.trigger]}
                  {r.conditions.keywords?.length ? <div className="text-gray-500">Từ khoá: {r.conditions.keywords.join(', ')}</div> : null}
                  {r.conditions.intents?.length ? <div className="text-gray-500">Ý định: {r.conditions.intents.map((k) => list.data!.intents.find((i) => i.key === k)?.label ?? k).join(', ')}</div> : null}
                </td>
                <td className="px-3 py-2 text-xs">{r.actions.map((a) => ACTION_LABEL[a.type]).join(' → ')}</td>
                <td className="px-3 py-2">
                  <Toggle label="Bật quy tắc" checked={r.enabled} disabled={!can.admin} onChange={(v) => patch(r, { enabled: v })} />
                </td>
                <td className="px-3 py-2">
                  <Toggle label="Chế độ thử" checked={r.testMode} disabled={!can.admin} onChange={(v) => patch(r, { testMode: v })} />
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <Button size="sm" variant="ghost" onClick={() => setExecFor(r)}>
                    Lịch sử
                  </Button>
                  {can.admin && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setEdit(structuredClone(r))}>
                        Sửa
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-red-600"
                        onClick={async () => {
                          if (!confirm(`Xoá quy tắc "${r.name}"?`)) return;
                          await api(`/rules/${r.id}`, { method: 'DELETE' }).catch((e) => toast(e.message, 'error'));
                          list.reload();
                        }}
                      >
                        Xoá
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <RuleTester />

      {edit && list.data && <RuleEditor rule={edit} setRule={setEdit} intents={list.data.intents} members={members.data?.items ?? []} onSave={save} />}
      {execFor && <Executions rule={execFor} onClose={() => setExecFor(null)} />}
    </div>
  );
}

function RuleEditor({ rule, setRule, intents, members, onSave }: { rule: Rule; setRule: (r: Rule | null) => void; intents: { key: string; label: string }[]; members: any[]; onSave: () => void }) {
  const set = (p: Partial<Rule>) => setRule({ ...rule, ...p });
  const setCond = (p: Partial<Rule['conditions']>) => set({ conditions: { ...rule.conditions, ...p } });
  const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
  const setAction = (i: number, p: Partial<Action>) => set({ actions: rule.actions.map((a, j) => (j === i ? { ...a, ...p } : a)) });
  return (
    <Modal open onClose={() => setRule(null)} title={rule.id ? 'Sửa quy tắc' : 'Thêm quy tắc'} wide footer={<><Button variant="secondary" onClick={() => setRule(null)}>Huỷ</Button><Button onClick={onSave}>Lưu</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Tên quy tắc">
          <Input value={rule.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Kích hoạt khi">
          <Select className="w-full" value={rule.trigger} onChange={(e) => set({ trigger: e.target.value })}>
            {Object.entries(TRIGGER_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Kênh áp dụng">
          <div className="flex gap-3 text-sm">
            {['FACEBOOK', 'ZALO'].map((t) => (
              <label key={t} className="flex items-center gap-1">
                <input type="checkbox" checked={rule.channelTypes.includes(t)} onChange={(e) => set({ channelTypes: e.target.checked ? [...rule.channelTypes, t] : rule.channelTypes.filter((x) => x !== t) })} />
                {t === 'FACEBOOK' ? 'Facebook' : 'Zalo'}
              </label>
            ))}
            <span className="text-xs text-gray-500">(không chọn = mọi kênh)</span>
          </div>
        </Field>
        <Field label="Ưu tiên" hint="Số nhỏ chạy trước">
          <Input type="number" value={rule.priority} onChange={(e) => set({ priority: Number(e.target.value) })} />
        </Field>
        <Field label="Từ khoá (phân tách bằng dấu phẩy)" hint="So khớp không dấu, theo từ: “gia” khớp “giá”, “Giá”">
          <Input value={(rule.conditions.keywords ?? []).join(', ')} onChange={(e) => setCond({ keywords: list(e.target.value) })} />
        </Field>
        <Field label="Cách khớp từ khoá">
          <Select className="w-full" value={rule.conditions.match ?? 'any'} onChange={(e) => setCond({ match: e.target.value as 'any' | 'all' })}>
            <option value="any">Chứa bất kỳ từ khoá nào</option>
            <option value="all">Chứa tất cả từ khoá</option>
          </Select>
        </Field>
        <Field label="Loại trừ nếu chứa">
          <Input value={(rule.conditions.excludeKeywords ?? []).join(', ')} onChange={(e) => setCond({ excludeKeywords: list(e.target.value) })} />
        </Field>
        <Field label="Ý định có sẵn">
          <div className="flex flex-wrap gap-2 text-sm">
            {intents.map((i) => (
              <label key={i.key} className="flex items-center gap-1">
                <input type="checkbox" checked={rule.conditions.intents?.includes(i.key) ?? false} onChange={(e) => setCond({ intents: e.target.checked ? [...(rule.conditions.intents ?? []), i.key] : (rule.conditions.intents ?? []).filter((x) => x !== i.key) })} />
                {i.label}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Thời gian nghỉ giữa hai lần chạy (phút)">
          <Input type="number" min={0} value={Math.round(rule.cooldownSeconds / 60)} onChange={(e) => set({ cooldownSeconds: Number(e.target.value) * 60 })} />
        </Field>
        <Field label="Số lần chạy tối đa mỗi hội thoại" hint="Để trống = không giới hạn">
          <Input type="number" min={1} value={rule.maxRunsPerConversation ?? ''} onChange={(e) => set({ maxRunsPerConversation: e.target.value ? Number(e.target.value) : null })} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <Toggle checked={rule.isGreeting} onChange={(v) => set({ isGreeting: v })} /> Là lời chào (chỉ gửi một lần mỗi hội thoại)
        </label>
        <label className="flex items-center gap-2">
          <Toggle checked={rule.enabled} onChange={(v) => set({ enabled: v })} /> Bật
        </label>
        <label className="flex items-center gap-2">
          <Toggle checked={rule.testMode} onChange={(v) => set({ testMode: v })} /> Chế độ thử (không gửi)
        </label>
      </div>
      <div>
        <h4 className="mb-1 text-sm font-medium">Hành động</h4>
        <div className="space-y-2">
          {rule.actions.map((a, i) => (
            <div key={i} className="flex items-start gap-2 rounded border p-2">
              <Select value={a.type} onChange={(e) => setAction(i, { type: e.target.value })}>
                {Object.entries(ACTION_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
              <div className="flex-1">
                {a.type === 'SEND_TEXT' && <Textarea rows={2} value={a.text ?? ''} onChange={(e) => setAction(i, { text: e.target.value })} placeholder="Nội dung trả lời" />}
                {a.type === 'ADD_TAG' && <Input value={a.tagName ?? ''} onChange={(e) => setAction(i, { tagName: e.target.value })} placeholder="Tên nhãn" />}
                {a.type === 'ASSIGN' && (
                  <Select className="w-full" value={a.userId ?? ''} onChange={(e) => setAction(i, { userId: e.target.value })}>
                    <option value="">Chọn nhân viên…</option>
                    {members.filter((m) => m.role !== 'VIEWER').map((m) => (
                      <option key={m.user.id} value={m.user.id}>
                        {m.user.name}
                      </option>
                    ))}
                  </Select>
                )}
                {a.type === 'HANDOFF' && <Input value={a.reason ?? ''} onChange={(e) => setAction(i, { reason: e.target.value })} placeholder="Lý do chuyển (hiển thị cho nhân viên)" />}
                {a.type === 'SET_STATUS' && (
                  <Select value={a.status ?? 'OPEN'} onChange={(e) => setAction(i, { status: e.target.value })}>
                    <option value="NEW">Mới</option>
                    <option value="OPEN">Đang xử lý</option>
                    <option value="PENDING">Chờ khách</option>
                    <option value="RESOLVED">Đã giải quyết</option>
                  </Select>
                )}
                {a.type === 'START_LEAD_CAPTURE' && <p className="text-xs text-gray-500">Bot hỏi lần lượt tên → số điện thoại → nhu cầu, lưu vào hồ sơ khách rồi chuyển nhân viên.</p>}
              </div>
              <button aria-label="Xoá hành động" onClick={() => set({ actions: rule.actions.filter((_, j) => j !== i) })} className="p-1 text-gray-400 hover:text-red-600">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
        <Button size="sm" variant="secondary" className="mt-2" onClick={() => set({ actions: [...rule.actions, { type: 'SEND_TEXT', text: '' }] })}>
          <Plus className="h-3.5 w-3.5" /> Thêm hành động
        </Button>
      </div>
    </Modal>
  );
}

function RuleTester() {
  const toast = useToast();
  const [text, setText] = useState('Shop ơi giá bao nhiêu vậy');
  const [channelType, setChannelType] = useState('FACEBOOK');
  const [isNew, setIsNew] = useState(false);
  const [at, setAt] = useState('');
  const [res, setRes] = useState<any>(null);
  async function run() {
    try {
      setRes(await api('/rules/test', { body: { text, channelType, isNewConversation: isNew, at: at ? new Date(at).toISOString() : undefined } }));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }
  return (
    <Card title="Thử quy tắc (không gửi tin)" className="mt-6">
      <div className="grid gap-3 md:grid-cols-[1fr_auto_auto_auto_auto] md:items-end">
        <Field label="Câu khách gửi">
          <Input value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        <Field label="Kênh">
          <Select value={channelType} onChange={(e) => setChannelType(e.target.value)}>
            <option value="FACEBOOK">Facebook</option>
            <option value="ZALO">Zalo</option>
          </Select>
        </Field>
        <Field label="Thời điểm (giờ máy bạn)">
          <Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
        </Field>
        <label className="flex h-9 items-center gap-1 text-sm">
          <input type="checkbox" checked={isNew} onChange={(e) => setIsNew(e.target.checked)} /> Hội thoại mới
        </label>
        <Button onClick={run}>Thử</Button>
      </div>
      {res && (
        <div className="mt-3 space-y-2">
          <Notice tone="info">{res.outsideHours ? 'Thời điểm này nằm NGOÀI giờ làm việc.' : 'Thời điểm này trong giờ làm việc.'}</Notice>
          <Table head={['Quy tắc', 'Khớp', 'Giải thích', 'Kết quả']}>
            {res.results.map((r: any) => (
              <tr key={r.ruleId}>
                <td className="px-3 py-2 font-medium">{r.name}</td>
                <td className="px-3 py-2">{r.matched ? <Badge className="bg-green-100 text-green-800">Có</Badge> : <Badge>Không</Badge>}</td>
                <td className="px-3 py-2 text-xs text-gray-600">{r.why}</td>
                <td className="px-3 py-2 text-xs">{r.outcome}</td>
              </tr>
            ))}
          </Table>
        </div>
      )}
    </Card>
  );
}

function Executions({ rule, onClose }: { rule: Rule; onClose: () => void }) {
  const ex = useApi<{ items: any[] }>(`/rules/${rule.id}/executions`);
  return (
    <Modal open onClose={onClose} title={`Lịch sử chạy: ${rule.name}`} wide>
      {ex.loading ? (
        <Spinner />
      ) : !ex.data?.items.length ? (
        <Empty title="Chưa có lần chạy nào" />
      ) : (
        <Table head={['Thời gian', 'Kết quả', 'Chi tiết']}>
          {ex.data.items.map((e) => (
            <tr key={e.id}>
              <td className="whitespace-nowrap px-3 py-2">{fmtDateTime(e.createdAt)}</td>
              <td className="px-3 py-2">{EXEC_LABEL[e.status] ?? e.status}</td>
              <td className="px-3 py-2 text-xs text-gray-600">
                {e.detail}{' '}
                <a className="text-brand-600 underline" href={`/inbox?c=${e.conversationId}`}>
                  Mở hội thoại
                </a>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Modal>
  );
}
