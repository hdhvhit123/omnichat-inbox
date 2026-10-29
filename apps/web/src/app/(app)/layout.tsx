'use client';
import clsx from 'clsx';
import { BarChart3, Bot, Cable, FileText, Home, Inbox, LogOut, MessageSquareText, Settings, Users, UserCog, Workflow } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ReactNode, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { ROLE_LABEL } from '@/lib/labels';
import { SessionProvider, useSession, useSocketEvent } from '@/lib/session';
import { Spinner } from '@/components/ui';

const NAV = [
  { href: '/', label: 'Tổng quan', icon: Home },
  { href: '/inbox', label: 'Hộp thư', icon: Inbox },
  { href: '/customers', label: 'Khách hàng', icon: Users },
  { href: '/canned', label: 'Câu trả lời mẫu', icon: MessageSquareText },
  { href: '/rules', label: 'Quy tắc tự động', icon: Workflow },
  { href: '/ai', label: 'Chatbot & kho kiến thức', icon: Bot },
  { href: '/channels', label: 'Kết nối kênh', icon: Cable },
  { href: '/members', label: 'Nhân viên & phân quyền', icon: UserCog },
  { href: '/reports', label: 'Báo cáo', icon: BarChart3, roles: ['OWNER', 'MANAGER', 'VIEWER'] },
  { href: '/settings', label: 'Cài đặt & nhật ký', icon: Settings },
];

function Shell({ children }: { children: ReactNode }) {
  const { user, ws, workspaces, switchWorkspace, connected } = useSession();
  const path = usePathname();
  const [unhandled, setUnhandled] = useState(0);
  const refresh = () => api('/conversations/unhandled-count').then((r) => setUnhandled(r.count)).catch(() => undefined);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, []);
  useSocketEvent('conversation.updated', refresh);

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r bg-white">
        <div className="border-b px-4 py-3">
          <div className="flex items-center gap-2 font-semibold text-brand-700">
            <FileText className="h-5 w-5" /> OmniChat Inbox
          </div>
          {workspaces.length > 1 ? (
            <select aria-label="Chọn workspace" className="mt-2 w-full rounded border px-2 py-1 text-sm" value={ws.id} onChange={(e) => switchWorkspace(e.target.value)}>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                  {w.isDemo ? ' (mô phỏng)' : ''}
                </option>
              ))}
            </select>
          ) : (
            <div className="mt-1 text-sm text-gray-600">{ws.name}</div>
          )}
          {ws.isDemo && <div className="mt-2 rounded bg-amber-100 px-2 py-1 text-center text-xs font-semibold text-amber-900">Dữ liệu mô phỏng</div>}
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {NAV.filter((n) => !n.roles || n.roles.includes(ws.role)).map((n) => {
            const active = n.href === '/' ? path === '/' : path.startsWith(n.href);
            return (
              <Link key={n.href} href={n.href} className={clsx('flex items-center gap-2 rounded-md px-3 py-2 text-sm', active ? 'bg-brand-50 font-medium text-brand-700' : 'text-gray-700 hover:bg-gray-100')}>
                <n.icon className="h-4 w-4" />
                <span className="flex-1">{n.label}</span>
                {n.href === '/inbox' && unhandled > 0 && <span className="rounded-full bg-red-600 px-1.5 text-xs text-white">{unhandled}</span>}
              </Link>
            );
          })}
        </nav>
        <div className="border-t p-3 text-sm">
          <div className="flex items-center gap-1.5 text-xs" title={connected ? 'Đang nhận cập nhật thời gian thực' : 'Mất kết nối thời gian thực — dữ liệu có thể chưa mới nhất'}>
            <span className={clsx('h-2 w-2 rounded-full', connected ? 'bg-green-500' : 'bg-red-500')} />
            {connected ? 'Realtime: đã kết nối' : 'Realtime: mất kết nối'}
          </div>
          <div className="mt-2 font-medium">{user.name}</div>
          <div className="text-xs text-gray-500">{ROLE_LABEL[ws.role]}</div>
          <button
            className="mt-2 flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900"
            onClick={async () => {
              await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
              window.location.href = '/login';
            }}
          >
            <LogOut className="h-3.5 w-3.5" /> Đăng xuất
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider fallback={<Spinner />}>
      <Shell>{children}</Shell>
    </SessionProvider>
  );
}
