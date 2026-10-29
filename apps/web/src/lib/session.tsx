'use client';
import { useRouter } from 'next/navigation';
import { ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { api, setWorkspaceId } from './api';

export type Role = 'OWNER' | 'MANAGER' | 'AGENT' | 'VIEWER';
export type WorkspaceInfo = { id: string; name: string; slug: string; isDemo: boolean; timezone: string; role: Role };
type SessionValue = {
  user: { id: string; email: string; name: string };
  workspaces: WorkspaceInfo[];
  ws: WorkspaceInfo;
  switchWorkspace: (id: string) => void;
  socket: Socket | null;
  connected: boolean;
  can: { write: boolean; admin: boolean; owner: boolean };
};

const Ctx = createContext<SessionValue | null>(null);
const WS_KEY = 'omni_ws';

export function SessionProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<{ user: SessionValue['user']; workspaces: WorkspaceInfo[]; wsId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const wsIdRef = useRef<string | null>(null);

  useEffect(() => {
    api('/auth/me')
      .then((me) => {
        if (!me.workspaces.length) {
          setError('Tài khoản chưa thuộc workspace nào. Liên hệ chủ sở hữu để được thêm.');
          return;
        }
        let saved: string | null = null;
        try {
          saved = localStorage.getItem(WS_KEY);
        } catch {}
        const ws = me.workspaces.find((w: WorkspaceInfo) => w.id === saved) ?? me.workspaces[0];
        setWorkspaceId(ws.id);
        wsIdRef.current = ws.id;
        setState({ user: me.user, workspaces: me.workspaces, wsId: ws.id });
      })
      .catch((e) => {
        if (e.status === 401) router.replace('/login');
        else setError(e.message);
      });
  }, [router]);

  // WebSocket: cookie phiên gửi kèm; máy chủ chỉ cho vào phòng của kênh được cấp quyền
  useEffect(() => {
    if (!state) return;
    const s = io(process.env.NEXT_PUBLIC_SOCKET_URL || undefined, { path: '/socket.io', withCredentials: true, transports: ['websocket', 'polling'] });
    const join = () => s.emit('join', { workspaceId: wsIdRef.current }, () => setConnected(true));
    s.on('connect', join);
    s.on('disconnect', () => setConnected(false));
    s.on('connect_error', () => setConnected(false));
    setSocket(s);
    return () => {
      s.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!state]);

  const switchWorkspace = useCallback(
    (id: string) => {
      try {
        localStorage.setItem(WS_KEY, id);
      } catch {}
      setWorkspaceId(id);
      wsIdRef.current = id;
      setState((s) => (s ? { ...s, wsId: id } : s));
      socket?.emit('join', { workspaceId: id });
      router.push('/');
    },
    [socket, router],
  );

  if (error) return <div className="p-8 text-sm text-red-700">{error}</div>;
  if (!state) return <>{fallback}</>;
  const ws = state.workspaces.find((w) => w.id === state.wsId)!;
  const value: SessionValue = {
    user: state.user,
    workspaces: state.workspaces,
    ws,
    switchWorkspace,
    socket,
    connected,
    can: { write: ws.role !== 'VIEWER', admin: ws.role === 'OWNER' || ws.role === 'MANAGER', owner: ws.role === 'OWNER' },
  };
  return (
    <Ctx.Provider value={value} key={ws.id}>
      {children}
    </Ctx.Provider>
  );
}

export function useSession() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside provider');
  return v;
}

/** Đăng ký sự kiện realtime; handler luôn là bản mới nhất. */
export function useSocketEvent<T = any>(event: string, handler: (payload: T) => void) {
  const { socket } = useSession();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!socket) return;
    const fn = (p: T) => ref.current(p);
    socket.on(event, fn);
    return () => {
      socket.off(event, fn);
    };
  }, [socket, event]);
}
