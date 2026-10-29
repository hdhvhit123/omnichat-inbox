'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

/** Tải dữ liệu với trạng thái đang tải / lỗi / tải lại. */
export function useApi<T = any>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const my = ++seq.current;
    setLoading(true);
    try {
      const d = await api<T>(path);
      if (my === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e: any) {
      if (my === seq.current) setError(e);
    } finally {
      if (my === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => {
    load();
  }, [load]);
  return { data, error, loading, reload: load, setData };
}

/** Chạy một thao tác, hiển thị lỗi bằng toast. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async <R,>(key: string, fn: () => Promise<R>, onError?: (e: any) => void): Promise<R | undefined> => {
    setBusy(key);
    try {
      return await fn();
    } catch (e: any) {
      onError?.(e);
      return undefined;
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, run };
}
