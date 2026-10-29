'use client';
import { MessagesSquare } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Empty, Spinner } from '@/components/ui';
import { ConversationList } from '@/components/inbox/ConversationList';
import { ConversationView } from '@/components/inbox/ConversationView';
import { CustomerPanel } from '@/components/inbox/CustomerPanel';
import { SimulatorPanel } from '@/components/inbox/SimulatorPanel';
import type { Member, Tag } from '@/components/inbox/types';

function Inbox() {
  const { ws } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const selected = params.get('c');
  const [members, setMembers] = useState<Member[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [channels, setChannels] = useState<any[]>([]);
  const [, setVersion] = useState(0);

  useEffect(() => {
    api('/members').then((r) => setMembers(r.items)).catch(() => undefined);
    api('/tags').then((r) => setTags(r.items)).catch(() => undefined);
    api('/channels').then((r) => setChannels(r.items)).catch(() => undefined);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b bg-white px-4 py-2">
        <h1 className="font-semibold">Hộp thư</h1>
        {ws.isDemo && <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">Dữ liệu mô phỏng</span>}
        <div className="ml-auto">{ws.isDemo && <SimulatorPanel />}</div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="w-80 shrink-0 border-r bg-white">
          <ConversationList selectedId={selected} onSelect={(id) => router.push(`/inbox?c=${id}`)} members={members} tags={tags} channels={channels} />
        </div>
        <div className="min-w-0 flex-1">
          {selected ? (
            <ConversationView key={selected} id={selected} members={members} onChanged={() => setVersion((v) => v + 1)} />
          ) : (
            <div className="flex h-full items-center justify-center">
              <Empty title="Chọn một hội thoại để xem">
                <MessagesSquare className="h-6 w-6 text-gray-300" />
              </Empty>
            </div>
          )}
        </div>
        {selected && (
          <div className="hidden w-80 shrink-0 border-l bg-white xl:block">
            <CustomerPanel key={selected} conversationId={selected} tags={tags} />
          </div>
        )}
      </div>
    </div>
  );
}

export default function InboxPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Inbox />
    </Suspense>
  );
}
