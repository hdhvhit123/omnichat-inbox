'use client';
import clsx from 'clsx';
import { AlertCircle, Bot, Search, UserRound } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, qs } from '@/lib/api';
import { fmtShort } from '@/lib/format';
import { CONV_STATUS } from '@/lib/labels';
import { useSession, useSocketEvent } from '@/lib/session';
import { Button, Empty, ErrorBox, Input, Select, Spinner } from '@/components/ui';
import type { ConvItem, Member, Tag } from './types';

export type Filters = { status: string; channelType: string; channelId: string; assignee: string; tagId: string; q: string };
export const DEFAULT_FILTERS: Filters = { status: 'ACTIVE', channelType: '', channelId: '', assignee: '', tagId: '', q: '' };

/** Cảnh báo hội thoại chưa được xử lý quá lâu (khách đã nhắn, chưa ai trả lời). */
const UNHANDLED_ALERT_MIN = 15;

export function ConversationList({ selectedId, onSelect, members, tags, channels }: { selectedId: string | null; onSelect: (id: string) => void; members: Member[]; tags: Tag[]; channels: any[] }) {
  const { ws } = useSession();
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [q, setQ] = useState('');
  const [items, setItems] = useState<ConvItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const seq = useRef(0);
  const [, tick] = useState(0);

  const load = useCallback(
    async (append = false, after: string | null = null) => {
      const my = ++seq.current;
      if (!append) setLoading(true);
      try {
        const r = await api<{ items: ConvItem[]; nextCursor: string | null }>(`/conversations${qs({ ...filters, cursor: after })}`);
        if (my !== seq.current) return;
        setItems((prev) => (append ? [...prev, ...r.items.filter((i) => !prev.some((p) => p.id === i.id))] : r.items));
        setCursor(r.nextCursor);
        setError(null);
      } catch (e: any) {
        if (my === seq.current) setError(e);
      } finally {
        if (my === seq.current) setLoading(false);
      }
    },
    [filters],
  );

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === q ? f : { ...f, q })), 350);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // Cập nhật realtime: tải lại trang đầu (gộp nhiều sự kiện liên tiếp)
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = () => {
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => load(), 400);
  };
  useSocketEvent('conversation.updated', refresh);
  useSocketEvent('conversation.assigned', refresh);
  useSocketEvent('message.created', refresh);
  const { connected } = useSession();
  useEffect(() => {
    if (connected) return;
    const t = setInterval(() => load(), 10_000);
    return () => clearInterval(t);
  }, [connected, load]);

  const set = (k: keyof Filters, v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const name = (id: string | null) => members.find((m) => m.user.id === id)?.user.name;

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b p-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
          <Input className="pl-8" placeholder="Tìm tên, SĐT, nội dung tin…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Tìm kiếm hội thoại" />
        </div>
        <div className="flex flex-wrap gap-1">
          {[['ACTIVE', 'Cần xử lý'], ['NEW', 'Mới'], ['OPEN', 'Đang xử lý'], ['PENDING', 'Chờ khách'], ['RESOLVED', 'Đã giải quyết'], ['', 'Tất cả']].map(([k, l]) => (
            <button key={k} onClick={() => set('status', k)} className={clsx('rounded-full px-2.5 py-1 text-xs', filters.status === k ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200')}>
              {l}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <Select aria-label="Lọc theo kênh" value={filters.channelType} onChange={(e) => setFilters((f) => ({ ...f, channelType: e.target.value, channelId: '' }))}>
            <option value="">Mọi kênh</option>
            <option value="FACEBOOK">Facebook</option>
            <option value="ZALO">Zalo OA</option>
          </Select>
          <Select aria-label="Lọc theo tài khoản" value={filters.channelId} onChange={(e) => set('channelId', e.target.value)}>
            <option value="">Mọi tài khoản</option>
            {channels.filter((c) => !filters.channelType || c.type === filters.channelType).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Select aria-label="Lọc theo người phụ trách" value={filters.assignee} onChange={(e) => set('assignee', e.target.value)}>
            <option value="">Mọi người phụ trách</option>
            <option value="me">Của tôi</option>
            <option value="none">Chưa phân công</option>
            {members.map((m) => (
              <option key={m.user.id} value={m.user.id}>
                {m.user.name}
              </option>
            ))}
          </Select>
          <Select aria-label="Lọc theo nhãn" value={filters.tagId} onChange={(e) => set('tagId', e.target.value)}>
            <option value="">Mọi nhãn</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className="scroll-thin flex-1 overflow-y-auto">
        {error && (
          <div className="p-3">
            <ErrorBox error={error} onRetry={() => load()} />
          </div>
        )}
        {loading && !items.length ? (
          <Spinner />
        ) : !items.length && !error ? (
          <Empty title="Không có hội thoại">{ws.isDemo ? 'Dùng nút "Mô phỏng" để tạo tin nhắn của khách.' : 'Hội thoại xuất hiện khi khách nhắn tới kênh đã kết nối.'}</Empty>
        ) : (
          <ul>
            {items.map((c) => {
              const waitMin = c.lastInboundAt && c.unreadCount > 0 && ['NEW', 'OPEN'].includes(c.status) ? (Date.now() - new Date(c.lastInboundAt).getTime()) / 60_000 : 0;
              return (
                <li key={c.id}>
                  <button onClick={() => onSelect(c.id)} className={clsx('block w-full border-b px-3 py-2.5 text-left hover:bg-gray-50', selectedId === c.id && 'bg-brand-50')}>
                    <div className="flex items-center gap-2">
                      <span className={clsx('h-2 w-2 shrink-0 rounded-full', c.channel.type === 'FACEBOOK' ? 'bg-blue-600' : 'bg-sky-400')} title={c.channel.type === 'FACEBOOK' ? 'Facebook' : 'Zalo'} />
                      <span className={clsx('flex-1 truncate text-sm', c.unreadCount > 0 ? 'font-semibold' : 'font-medium')}>{c.customer.displayName}</span>
                      <span className="text-xs text-gray-500">{fmtShort(c.lastMessageAt)}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2">
                      <span className="flex-1 truncate text-xs text-gray-600">{c.lastMessagePreview ?? '—'}</span>
                      {c.unreadCount > 0 && <span className="rounded-full bg-brand-600 px-1.5 text-[10px] font-semibold text-white">{c.unreadCount}</span>}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px]">
                      <span className={clsx('rounded px-1.5', CONV_STATUS[c.status]?.cls)}>{CONV_STATUS[c.status]?.label}</span>
                      <span className="truncate text-gray-500">{c.channel.name}</span>
                      {c.assigneeId ? (
                        <span className="flex items-center gap-0.5 text-gray-600">
                          <UserRound className="h-3 w-3" />
                          {name(c.assigneeId) ?? 'Đã phân công'}
                        </span>
                      ) : (
                        <span className="text-gray-400">Chưa phân công</span>
                      )}
                      {c.handoffAt && c.botPaused && <span className="rounded bg-orange-100 px-1.5 text-orange-800">Cần nhân viên</span>}
                      {!c.botPaused && (c.botMode ?? '') === 'AUTO' && <Bot className="h-3 w-3 text-gray-500" />}
                      {waitMin >= UNHANDLED_ALERT_MIN && (
                        <span className="flex items-center gap-0.5 rounded bg-red-100 px-1.5 text-red-800">
                          <AlertCircle className="h-3 w-3" /> Chờ {Math.floor(waitMin)} phút
                        </span>
                      )}
                      {c.tags.slice(0, 2).map((t) => (
                        <span key={t.id} className="rounded bg-gray-100 px-1.5 text-gray-700">
                          {t.name}
                        </span>
                      ))}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {cursor && (
          <div className="p-3 text-center">
            <Button variant="secondary" size="sm" onClick={() => load(true, cursor)}>
              Tải thêm
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
