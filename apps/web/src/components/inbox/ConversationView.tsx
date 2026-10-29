'use client';
import clsx from 'clsx';
import { Bot, Clock, FileIcon, Hand, Lock, Paperclip, RotateCcw, Send, Sparkles, StickyNote, X } from 'lucide-react';
import { KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { fmtBytes, fmtDateTime, fmtRemaining, fmtTime, vnDayKey, fmtDate } from '@/lib/format';
import { AI_STATUS, BOT_MODE, CONV_STATUS, MSG_STATUS, SENDER_LABEL } from '@/lib/labels';
import { useSession, useSocketEvent } from '@/lib/session';
import { Badge, Button, ErrorBox, Notice, Select, Spinner, Textarea, useToast } from '@/components/ui';
import type { AiTask, Member, Message, TimelineItem } from './types';

const newClientId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function ConversationView({ id, members, onChanged }: { id: string; members: Member[]; onChanged: () => void }) {
  const { user, can, socket, connected } = useSession();
  const toast = useToast();
  const [conv, setConv] = useState<any>(null);
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [tasks, setTasks] = useState<AiTask[]>([]);
  const [presence, setPresence] = useState<Record<string, { name: string; kind: 'typing' | 'viewing'; at: number }>>({});
  const scroller = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);

  const loadConv = useCallback(() => api(`/conversations/${id}`).then(setConv).catch(setError), [id]);
  const loadTasks = useCallback(() => api<{ items: AiTask[] }>(`/conversations/${id}/ai-tasks`).then((r) => setTasks(r.items)).catch(() => undefined), [id]);

  useEffect(() => {
    setConv(null);
    setItems([]);
    setError(null);
    setPresence({});
    stickBottom.current = true;
    loadConv();
    loadTasks();
    api<{ items: TimelineItem[]; nextBefore: string | null }>(`/conversations/${id}/timeline`)
      .then((r) => {
        setItems(r.items);
        setNextBefore(r.nextBefore);
      })
      .catch(setError);
    if (can.write) api(`/conversations/${id}/read`, { method: 'POST' }).then(onChanged).catch(() => undefined);
    socket?.emit('viewing', { conversationId: id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (stickBottom.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [items]);

  async function loadOlder() {
    if (!nextBefore || !scroller.current) return;
    setLoadingOlder(true);
    const prevHeight = scroller.current.scrollHeight;
    try {
      const r = await api<{ items: TimelineItem[]; nextBefore: string | null }>(`/conversations/${id}/timeline?before=${encodeURIComponent(nextBefore)}`);
      stickBottom.current = false;
      setItems((x) => [...r.items.filter((i) => !x.some((y) => key(y) === key(i))), ...x]);
      setNextBefore(r.nextBefore);
      requestAnimationFrame(() => {
        if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight - prevHeight;
      });
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setLoadingOlder(false);
    }
  }

  const upsertMessage = (m: Message) =>
    setItems((x) => {
      const i = x.findIndex((y) => y.kind === 'message' && (y.message.id === m.id || (m.clientMsgId && y.message.clientMsgId === m.clientMsgId)));
      if (i >= 0) {
        const copy = [...x];
        copy[i] = { kind: 'message', at: m.sentAt, message: m };
        return copy;
      }
      return [...x, { kind: 'message' as const, at: m.sentAt, message: m }].sort((a, b) => a.at.localeCompare(b.at));
    });

  useSocketEvent<{ conversationId: string; message: Message }>('message.created', (p) => {
    if (p.conversationId !== id) return;
    const el = scroller.current;
    stickBottom.current = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    upsertMessage(p.message);
    if (p.message.direction === 'INBOUND' && can.write) api(`/conversations/${id}/read`, { method: 'POST' }).catch(() => undefined);
  });
  useSocketEvent<{ conversationId: string; message: Message }>('message.updated', (p) => p.conversationId === id && upsertMessage(p.message));
  const addNote = (note: any) => setItems((x) => (x.some((y) => y.kind === 'note' && y.note.id === note.id) ? x : [...x, { kind: 'note' as const, at: note.createdAt, note }]));
  useSocketEvent<{ conversationId: string; note: any }>('note.created', (p) => p.conversationId === id && addNote(p.note));

  // Mất kết nối realtime: tự làm mới định kỳ để không bỏ lỡ tin
  useEffect(() => {
    if (connected) return;
    const t = setInterval(() => {
      api<{ items: TimelineItem[] }>(`/conversations/${id}/timeline`)
        .then((r) => setItems((x) => {
          const map = new Map(x.map((i) => [key(i), i]));
          for (const i of r.items) map.set(key(i), i);
          return [...map.values()].sort((a, b) => a.at.localeCompare(b.at));
        }))
        .catch(() => undefined);
      loadConv();
      loadTasks();
    }, 8000);
    return () => clearInterval(t);
  }, [connected, id, loadConv, loadTasks]);
  useSocketEvent<{ conversationId: string }>('conversation.updated', (p) => p.conversationId === id && loadConv());
  useSocketEvent<{ conversationId: string }>('ai.task', (p) => p.conversationId === id && loadTasks());
  const onPresence = (kind: 'typing' | 'viewing') => (p: { conversationId: string; userId: string; name?: string; at: number }) => {
    if (p.conversationId !== id || p.userId === user.id) return;
    setPresence((x) => ({ ...x, [`${kind}:${p.userId}`]: { name: p.name ?? members.find((m) => m.user.id === p.userId)?.user.name ?? 'Đồng nghiệp', kind, at: Date.now() } }));
  };
  useSocketEvent('agent.typing', onPresence('typing'));
  useSocketEvent('agent.viewing', onPresence('viewing'));
  useEffect(() => {
    const t = setInterval(() => setPresence((x) => Object.fromEntries(Object.entries(x).filter(([, v]) => Date.now() - v.at < (v.kind === 'typing' ? 6000 : 60000)))), 2000);
    return () => clearInterval(t);
  }, []);

  async function op(path: string, body: unknown, msg: string) {
    try {
      await api(`/conversations/${id}/${path}`, { body: body ?? {} });
      toast(msg);
      loadConv();
      loadTasks();
      onChanged();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }

  async function resend(m: Message) {
    try {
      await api(`/conversations/${id}/messages/${m.id}/resend`, { body: {} });
    } catch (e: any) {
      if (e.code === 'CONFIRM_DUPLICATE') {
        if (window.confirm(e.message)) await api(`/conversations/${id}/messages/${m.id}/resend`, { body: { confirmPossibleDuplicate: true } }).catch((x) => toast(x.message, 'error'));
      } else toast(e.message, 'error');
    }
  }

  if (error) return <div className="p-4"><ErrorBox error={error} /></div>;
  if (!conv) return <Spinner />;

  const nameOf = (uid: string | null) => (uid ? members.find((m) => m.user.id === uid)?.user.name ?? 'Nhân viên' : '');
  // Bản nháp đã lỗi thời nếu nhân viên đã tự trả lời sau khi AI soạn
  const lastAgentAt = items.reduce((acc, i) => (i.kind === 'message' && i.message.senderType === 'AGENT' && i.message.direction === 'OUTBOUND' && i.at > acc ? i.at : acc), '');
  const draft = tasks.find((t) => t.status === 'DRAFTED' && t.createdAt > lastAgentAt);
  const running = tasks.find((t) => t.status === 'QUEUED' || t.status === 'RUNNING');
  const pres = Object.values(presence);

  return (
    <div className="flex h-full flex-col">
      {/* Đầu hội thoại */}
      <div className="flex flex-wrap items-center gap-2 border-b bg-white px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{conv.customer.displayName}</div>
          <div className="text-xs text-gray-500">
            {conv.channel.type === 'FACEBOOK' ? 'Facebook' : 'Zalo OA'} · {conv.channel.name}
            {conv.channel.isSimulated && <Badge className="ml-1 bg-amber-100 text-amber-900">Mô phỏng</Badge>}
          </div>
        </div>
        <Select aria-label="Trạng thái" disabled={!can.write} value={conv.status} onChange={(e) => op('status', { status: e.target.value }, 'Đã đổi trạng thái')}>
          {Object.entries(CONV_STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Người phụ trách"
          disabled={!can.write}
          value={conv.assigneeId ?? ''}
          onChange={(e) => op('assign', { userId: e.target.value || null }, 'Đã cập nhật người phụ trách')}
        >
          <option value="">Chưa phân công</option>
          {members
            .filter((m) => m.role !== 'VIEWER' && (can.admin || m.user.id === user.id || m.user.id === conv.assigneeId))
            .map((m) => (
              <option key={m.user.id} value={m.user.id}>
                {m.user.id === user.id ? `${m.user.name} (tôi)` : m.user.name}
              </option>
            ))}
        </Select>
      </div>

      {/* Trạng thái bot */}
      <div className="flex flex-wrap items-center gap-2 border-b bg-gray-50 px-4 py-1.5 text-xs">
        <Bot className="h-3.5 w-3.5 text-gray-500" />
        <span>
          Chatbot: <b>{BOT_MODE[conv.effectiveBotMode]}</b>
          {conv.botMode == null && ' (theo kênh)'}
        </span>
        {conv.botPausedAt ? (
          <>
            <Badge className="bg-orange-100 text-orange-800">
              <Hand className="h-3 w-3" /> Bot tạm dừng{conv.botPausedById && conv.botPausedById !== 'external' ? ` — ${nameOf(conv.botPausedById)} tiếp quản` : ''}
            </Badge>
            {conv.botPausedReason && <span className="text-gray-600">{conv.botPausedReason}</span>}
            {can.write && (
              <Button size="sm" variant="secondary" onClick={() => op('resume-bot', {}, 'Bot đã được bật lại cho hội thoại này')}>
                Bật lại bot
              </Button>
            )}
          </>
        ) : (
          can.write &&
          conv.effectiveBotMode !== 'MANUAL' && (
            <Button size="sm" variant="secondary" onClick={() => op('takeover', {}, 'Đã tiếp quản: bot dừng ngay, tác vụ AI đang chờ bị huỷ')}>
              <Hand className="h-3.5 w-3.5" /> Tiếp quản
            </Button>
          )
        )}
        {can.admin && (
          <Select aria-label="Chế độ bot cho hội thoại" className="ml-auto h-7 text-xs" value={conv.botMode ?? ''} onChange={(e) => api(`/conversations/${id}/bot-mode`, { method: 'PATCH', body: { mode: e.target.value || null } }).then(loadConv).catch((x) => toast(x.message, 'error'))}>
            <option value="">Theo kênh</option>
            {Object.entries(BOT_MODE).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        )}
      </div>

      {/* Dòng thời gian */}
      <div ref={scroller} className="scroll-thin flex-1 space-y-2 overflow-y-auto bg-gray-50 px-4 py-3">
        {nextBefore ? (
          <div className="text-center">
            <Button size="sm" variant="ghost" onClick={loadOlder} loading={loadingOlder}>
              Tải tin cũ hơn
            </Button>
          </div>
        ) : (
          <p className="text-center text-xs text-gray-400">Đầu hội thoại trong hệ thống. Tin nhắn trước thời điểm kết nối kênh không được nền tảng cung cấp.</p>
        )}
        {items.map((it, i) => {
          const prev = items[i - 1];
          const showDay = !prev || vnDayKey(prev.at) !== vnDayKey(it.at);
          return (
            <div key={key(it)}>
              {showDay && <div className="my-2 text-center text-xs text-gray-400">{fmtDate(it.at)}</div>}
              {it.kind === 'note' ? (
                <div className="mx-auto max-w-[80%] rounded-md border border-yellow-300 bg-yellow-50 px-3 py-2 text-sm">
                  <div className="mb-0.5 flex items-center gap-1 text-xs font-medium text-yellow-800">
                    <Lock className="h-3 w-3" /> Ghi chú nội bộ · {nameOf(it.note.authorId)} · {fmtTime(it.note.createdAt)}
                  </div>
                  <div className="whitespace-pre-wrap">{it.note.body}</div>
                </div>
              ) : (
                <MessageBubble m={it.message} authorName={nameOf(it.message.authorId)} onResend={can.write ? resend : undefined} />
              )}
            </div>
          );
        })}
      </div>

      {pres.length > 0 && (
        <div className="border-t bg-white px-4 py-1 text-xs text-gray-600">
          {pres.filter((p) => p.kind === 'typing').map((p) => p.name).join(', ') && <span className="mr-3 text-brand-700">{pres.filter((p) => p.kind === 'typing').map((p) => p.name).join(', ')} đang soạn trả lời…</span>}
          {pres.filter((p) => p.kind === 'viewing').length > 0 && <span>Đang xem: {[...new Set(pres.filter((p) => p.kind === 'viewing').map((p) => p.name))].join(', ')}</span>}
        </div>
      )}

      <AiPanel convId={id} draft={draft} running={running} tasks={tasks} onDone={loadTasks} canWrite={can.write} />
      {can.write ? <Composer conv={conv} onSent={upsertMessage} onNote={addNote} socketEmit={() => socket?.emit('typing', { conversationId: id })} /> : <div className="border-t bg-white p-3 text-center text-sm text-gray-500">Vai trò Người xem chỉ được đọc hội thoại.</div>}
    </div>
  );
}

function key(i: TimelineItem) {
  return i.kind === 'note' ? `n:${i.note.id}` : `m:${i.message.id}`;
}

function MessageBubble({ m, authorName, onResend }: { m: Message; authorName: string; onResend?: (m: Message) => void }) {
  const inbound = m.direction === 'INBOUND';
  const st = MSG_STATUS[m.status];
  const who = inbound ? 'Khách' : m.senderType === 'AGENT' ? (m.sentOutsideSystem ? 'Gửi từ công cụ khác' : authorName || 'Nhân viên') : SENDER_LABEL[m.senderType];
  return (
    <div className={clsx('flex', inbound ? 'justify-start' : 'justify-end')}>
      <div
        className={clsx(
          'max-w-[75%] rounded-lg px-3 py-2 text-sm shadow-sm',
          inbound && 'bg-white text-gray-900',
          !inbound && m.senderType === 'AGENT' && 'bg-brand-600 text-white',
          !inbound && (m.senderType === 'BOT' || m.senderType === 'RULE') && 'border border-violet-200 bg-violet-50 text-violet-950',
          !inbound && m.senderType === 'SYSTEM' && 'bg-gray-200 text-gray-800',
          ['FAILED', 'BLOCKED'].includes(m.status) && 'ring-2 ring-red-400',
          m.status === 'UNKNOWN' && 'ring-2 ring-orange-400',
        )}
      >
        <div className={clsx('mb-0.5 flex items-center gap-1 text-[11px]', !inbound && m.senderType === 'AGENT' ? 'text-blue-100' : 'text-gray-500')}>
          {(m.senderType === 'BOT' || m.senderType === 'RULE') && <Bot className="h-3 w-3" />}
          {who}
        </div>
        {m.text && <div className="whitespace-pre-wrap break-words">{m.text}</div>}
        {m.attachments?.map((a, i) => <Attachment key={i} a={a} />)}
        <div className={clsx('mt-1 flex items-center justify-end gap-1.5 text-[11px]', !inbound && m.senderType === 'AGENT' ? 'text-blue-100' : 'text-gray-500')}>
          <span title={fmtDateTime(m.sentAt)}>{fmtTime(m.sentAt)}</span>
          {!inbound && st && (
            <span title={[st.hint, m.errorMessage].filter(Boolean).join(' — ')} className={clsx(m.senderType === 'AGENT' && !['FAILED', 'BLOCKED', 'UNKNOWN'].includes(m.status) ? '' : st.cls, 'font-medium')}>
              · {st.label}
            </span>
          )}
        </div>
        {!inbound && m.errorMessage && ['FAILED', 'BLOCKED', 'UNKNOWN', 'CANCELLED'].includes(m.status) && (
          <div className="mt-1 rounded bg-white/80 px-2 py-1 text-xs text-red-700">{m.errorMessage}</div>
        )}
        {onResend && !inbound && ['FAILED', 'UNKNOWN'].includes(m.status) && (
          <button onClick={() => onResend(m)} className="mt-1 flex items-center gap-1 text-xs font-medium underline">
            <RotateCcw className="h-3 w-3" /> Gửi lại
          </button>
        )}
      </div>
    </div>
  );
}

function Attachment({ a }: { a: NonNullable<Message['attachments']>[number] }) {
  const [url, setUrl] = useState<string | null>(a.url ?? null);
  useEffect(() => {
    if (a.fileId) api(`/files/${a.fileId}/url`).then((r) => setUrl(r.url)).catch(() => undefined);
  }, [a.fileId]);
  const label = a.name ?? (a.type === 'image' ? 'Hình ảnh' : a.type === 'sticker' ? 'Nhãn dán' : 'Tệp đính kèm');
  if (a.type === 'image' && url) {
    return (
      <a href={url} target="_blank" rel="noreferrer noopener" className="mt-1 block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={label} className="max-h-48 rounded" referrerPolicy="no-referrer" />
      </a>
    );
  }
  return (
    <div className="mt-1 flex items-center gap-1 rounded bg-black/5 px-2 py-1 text-xs">
      <FileIcon className="h-3.5 w-3.5" />
      {url ? (
        <a href={url} target="_blank" rel="noreferrer noopener" className="underline">
          {label}
        </a>
      ) : (
        <span>{label} (nền tảng không cung cấp liên kết)</span>
      )}
      {a.size ? <span className="text-gray-500">· {fmtBytes(a.size)}</span> : null}
    </div>
  );
}

function AiPanel({ convId, draft, running, tasks, onDone, canWrite }: { convId: string; draft?: AiTask; running?: AiTask; tasks: AiTask[]; onDone: () => void; canWrite: boolean }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(draft?.draftText ?? ''), [draft?.id, draft?.draftText]);
  const last = tasks[0];

  async function suggest() {
    setBusy(true);
    try {
      const r = await api(`/conversations/${convId}/ai-suggest`, { method: 'POST' });
      if (r.task?.status === 'HANDOFF') toast(`AI không soạn được: ${r.task.reason ?? 'không có dữ liệu phù hợp'}`, 'info');
      onDone();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }
  async function approve() {
    if (!draft) return;
    setBusy(true);
    try {
      await api(`/ai-tasks/${draft.id}/approve`, { body: { text } });
      toast('Đã gửi câu trả lời');
      onDone();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }
  async function discard() {
    if (!draft) return;
    await api(`/ai-tasks/${draft.id}/discard`, { method: 'POST' }).catch((e) => toast(e.message, 'error'));
    onDone();
  }

  if (!canWrite) return null;
  if (draft) {
    return (
      <div className="border-t border-violet-200 bg-violet-50 px-4 py-2">
        <div className="mb-1 flex items-center gap-1 text-xs font-medium text-violet-900">
          <Sparkles className="h-3.5 w-3.5" /> Bản nháp AI — kiểm tra trước khi gửi
          {draft.reason && <span className="font-normal text-violet-700">· {draft.reason}</span>}
        </div>
        <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
        {draft.sources?.length ? (
          <details className="mt-1 text-xs text-violet-900">
            <summary className="cursor-pointer">Nguồn đã dùng ({draft.sources.length})</summary>
            <ul className="mt-1 space-y-1">
              {draft.sources.map((s) => (
                <li key={s.id} className="rounded bg-white p-2">
                  <b>
                    [{s.id}] {s.title} (v{s.version})
                  </b>
                  <div className="text-gray-700">{s.excerpt}</div>
                </li>
              ))}
            </ul>
          </details>
        ) : (
          <p className="mt-1 text-xs text-orange-700">Bản nháp không có nguồn tham chiếu — cần kiểm tra kỹ.</p>
        )}
        <div className="mt-2 flex gap-2">
          <Button size="sm" onClick={approve} loading={busy} disabled={!text.trim()}>
            <Send className="h-3.5 w-3.5" /> Duyệt và gửi
          </Button>
          <Button size="sm" variant="ghost" onClick={discard}>
            <X className="h-3.5 w-3.5" /> Bỏ nháp
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 border-t bg-white px-4 py-1.5 text-xs text-gray-600">
      {running ? (
        <span className="flex items-center gap-1">
          <Clock className="h-3.5 w-3.5 animate-pulse" /> AI đang xử lý tin của khách…
        </span>
      ) : last ? (
        <span>
          AI gần nhất: {AI_STATUS[last.status] ?? last.status}
          {last.reason ? ` — ${last.reason}` : ''}
        </span>
      ) : (
        <span>Chưa có gợi ý AI</span>
      )}
      <Button size="sm" variant="ghost" className="ml-auto" onClick={suggest} loading={busy}>
        <Sparkles className="h-3.5 w-3.5" /> AI gợi ý trả lời
      </Button>
    </div>
  );
}

function Composer({ conv, onSent, onNote, socketEmit }: { conv: any; onSent: (m: Message) => void; onNote: (n: any) => void; socketEmit: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [text, setText] = useState('');
  const [file, setFile] = useState<{ id: string; filename: string; size: number } | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [canned, setCanned] = useState<{ id: string; shortcut: string; title: string; body: string }[]>([]);
  const [showCanned, setShowCanned] = useState(false);
  const lastTyping = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const clientId = useRef(newClientId());

  useEffect(() => {
    api('/canned').then((r) => setCanned(r.items)).catch(() => undefined);
  }, []);
  useEffect(() => {
    setText('');
    setFile(null);
    setBlocked(null);
    clientId.current = newClientId();
  }, [conv.id]);

  const cannedQuery = text.startsWith('/') ? text.slice(1).toLowerCase() : null;
  const cannedMatches = useMemo(() => (cannedQuery === null ? [] : canned.filter((c) => c.shortcut.toLowerCase().includes(cannedQuery) || c.title.toLowerCase().includes(cannedQuery)).slice(0, 6)), [canned, cannedQuery]);

  const fill = (body: string) =>
    body.replace(/\{\{\s*ten_khach\s*\}\}/g, conv.customer.displayName).replace(/\{\{\s*ten_trang\s*\}\}/g, conv.channel.name);

  function onChange(v: string) {
    setText(v);
    setBlocked(null);
    if (mode === 'reply' && Date.now() - lastTyping.current > 3000) {
      lastTyping.current = Date.now();
      socketEmit();
    }
  }

  async function upload(f: File) {
    const form = new FormData();
    form.append('file', f);
    setBusy(true);
    try {
      const r = await api('/files', { form });
      setFile(r.file);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (busy) return;
    if (mode === 'note') {
      if (!text.trim()) return;
      setBusy(true);
      try {
        const r = await api(`/conversations/${conv.id}/notes`, { body: { body: text } });
        onNote(r.note);
        setText('');
      } catch (e: any) {
        toast(e.message, 'error');
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!text.trim() && !file) return;
    setBusy(true);
    try {
      // Văn bản và tệp gửi thành hai tin riêng
      if (file) {
        const r = await api(`/conversations/${conv.id}/messages`, { body: { fileId: file.id, clientMsgId: `${clientId.current}-f` } });
        onSent(r.message);
        setFile(null);
      }
      if (text.trim()) {
        const r = await api(`/conversations/${conv.id}/messages`, { body: { text, clientMsgId: clientId.current } });
        onSent(r.message);
        setText('');
      }
      clientId.current = newClientId();
      setBlocked(null);
    } catch (e: any) {
      // Bị chặn: giữ nguyên bản nháp, giải thích lý do
      if (e.code === 'SEND_BLOCKED') setBlocked(e.message);
      else toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (showCanned && cannedMatches.length && (e.key === 'Enter' || e.key === 'Tab') && cannedQuery !== null) {
      e.preventDefault();
      setText(fill(cannedMatches[0].body));
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  const win = conv.sendWindow;
  return (
    <div className={clsx('border-t px-4 py-2', mode === 'note' ? 'bg-yellow-50' : 'bg-white')}>
      <div className="mb-1.5 flex items-center gap-1 text-xs">
        <button onClick={() => setMode('reply')} className={clsx('rounded px-2 py-1', mode === 'reply' ? 'bg-brand-600 text-white' : 'hover:bg-gray-100')}>
          Trả lời khách
        </button>
        <button onClick={() => setMode('note')} className={clsx('flex items-center gap-1 rounded px-2 py-1', mode === 'note' ? 'bg-yellow-400 text-yellow-950' : 'hover:bg-gray-100')}>
          <StickyNote className="h-3 w-3" /> Ghi chú nội bộ
        </button>
        {mode === 'reply' && win && (
          <span className={clsx('ml-auto', win.open ? 'text-gray-500' : 'text-red-600')} title="Thời hạn trả lời theo chính sách nền tảng đang áp dụng">
            {win.expiresAt ? (win.open ? `Cửa sổ trả lời ${fmtRemaining(win.expiresAt)}` : 'Đã quá thời hạn trả lời tin thường') : 'Khách chưa nhắn tin'}
            {!win.open && win.agentExpiresAt && new Date(win.agentExpiresAt) > new Date() && ` · nhân viên ${fmtRemaining(win.agentExpiresAt)} (HUMAN_AGENT)`}
          </span>
        )}
        {mode === 'note' && <span className="ml-auto text-yellow-800">Chỉ nội bộ nhìn thấy — không bao giờ gửi cho khách</span>}
      </div>
      {blocked && (
        <div className="mb-2">
          <Notice tone="error">
            <b>Không gửi được:</b> {blocked}
          </Notice>
        </div>
      )}
      {file && (
        <div className="mb-1 flex items-center gap-2 text-xs">
          <Paperclip className="h-3.5 w-3.5" /> {file.filename} ({fmtBytes(file.size)})
          <button className="text-red-600" onClick={() => setFile(null)}>
            Bỏ
          </button>
        </div>
      )}
      <div className="relative flex items-end gap-2">
        {showCanned && cannedQuery !== null && cannedMatches.length > 0 && (
          <ul className="absolute bottom-full left-0 z-10 mb-1 w-96 rounded-md border bg-white shadow-lg">
            {cannedMatches.map((c) => (
              <li key={c.id}>
                <button className="block w-full px-3 py-1.5 text-left text-sm hover:bg-gray-50" onClick={() => setText(fill(c.body))}>
                  <b>/{c.shortcut}</b> <span className="text-gray-600">{c.title}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {mode === 'reply' && (
          <>
            <input ref={fileInput} type="file" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            <Button variant="ghost" size="sm" aria-label="Đính kèm tệp" onClick={() => fileInput.current?.click()} disabled={busy}>
              <Paperclip className="h-4 w-4" />
            </Button>
          </>
        )}
        <Textarea
          rows={2}
          value={text}
          onFocus={() => setShowCanned(true)}
          onBlur={() => setTimeout(() => setShowCanned(false), 200)}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKey}
          placeholder={mode === 'note' ? 'Ghi chú cho đồng nghiệp…' : 'Nhập tin trả lời (Enter để gửi, Shift+Enter xuống dòng, gõ / để chèn câu trả lời mẫu)'}
          className="resize-none"
        />
        <Button onClick={submit} loading={busy} disabled={!text.trim() && !file} variant={mode === 'note' ? 'secondary' : 'primary'}>
          {mode === 'note' ? <StickyNote className="h-4 w-4" /> : <Send className="h-4 w-4" />}
          {mode === 'note' ? 'Lưu ghi chú' : 'Gửi'}
        </Button>
      </div>
    </div>
  );
}
