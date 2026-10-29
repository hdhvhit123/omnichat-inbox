'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { Button, Card, Empty, ErrorBox, Field, Input, Modal, PageHeader, Spinner, Table, Textarea, useToast } from '@/components/ui';

type Canned = { id: string; shortcut: string; title: string; body: string };
type Tag = { id: string; name: string; color?: string };

export default function CannedPage() {
  const { can } = useSession();
  const toast = useToast();
  const list = useApi<{ items: Canned[] }>('/canned');
  const tags = useApi<{ items: Tag[] }>('/tags');
  const [edit, setEdit] = useState<Partial<Canned> | null>(null);
  const [tagName, setTagName] = useState('');

  async function save() {
    if (!edit) return;
    try {
      if (edit.id) await api(`/canned/${edit.id}`, { method: 'PATCH', body: { shortcut: edit.shortcut, title: edit.title, body: edit.body } });
      else await api('/canned', { body: edit });
      setEdit(null);
      list.reload();
      toast('Đã lưu');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }
  async function remove(c: Canned) {
    if (!confirm(`Xoá câu trả lời mẫu "${c.title}"?`)) return;
    await api(`/canned/${c.id}`, { method: 'DELETE' }).catch((e) => toast(e.message, 'error'));
    list.reload();
  }

  return (
    <div className="p-6">
      <PageHeader
        title="Câu trả lời mẫu"
        description={
          <>
            Gõ <code>/</code> + phím tắt trong ô trả lời để chèn nhanh. Biến hỗ trợ: <code>{'{{ten_khach}}'}</code>, <code>{'{{ten_trang}}'}</code>.
          </>
        }
        actions={can.admin && <Button onClick={() => setEdit({ shortcut: '', title: '', body: '' })}>Thêm câu mẫu</Button>}
      />
      <Card>
        {list.error ? (
          <ErrorBox error={list.error} onRetry={list.reload} />
        ) : list.loading ? (
          <Spinner />
        ) : !list.data?.items.length ? (
          <Empty title="Chưa có câu trả lời mẫu" />
        ) : (
          <Table head={['Phím tắt', 'Tiêu đề', 'Nội dung', '']}>
            {list.data.items.map((c) => (
              <tr key={c.id}>
                <td className="px-3 py-2 font-mono">/{c.shortcut}</td>
                <td className="px-3 py-2 font-medium">{c.title}</td>
                <td className="max-w-md truncate px-3 py-2 text-gray-600">{c.body}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  {can.admin && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setEdit(c)}>
                        Sửa
                      </Button>
                      <Button size="sm" variant="ghost" className="text-red-600" onClick={() => remove(c)}>
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

      <Card title="Nhãn" className="mt-6">
        <div className="flex flex-wrap gap-2">
          {tags.data?.items.map((t) => (
            <span key={t.id} className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-1 text-sm">
              {t.name}
              {can.admin && (
                <button
                  aria-label={`Xoá nhãn ${t.name}`}
                  className="text-gray-500 hover:text-red-600"
                  onClick={async () => {
                    if (!confirm(`Xoá nhãn "${t.name}" khỏi mọi hội thoại?`)) return;
                    await api(`/tags/${t.id}`, { method: 'DELETE' }).catch((e) => toast(e.message, 'error'));
                    tags.reload();
                  }}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
        {can.admin && (
          <form
            className="mt-3 flex max-w-sm gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!tagName.trim()) return;
              await api('/tags', { body: { name: tagName.trim() } }).catch((x) => toast(x.message, 'error'));
              setTagName('');
              tags.reload();
            }}
          >
            <Input value={tagName} onChange={(e) => setTagName(e.target.value)} placeholder="Tên nhãn mới" />
            <Button type="submit" variant="secondary">
              Thêm
            </Button>
          </form>
        )}
      </Card>

      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Sửa câu trả lời mẫu' : 'Thêm câu trả lời mẫu'} footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Huỷ</Button><Button onClick={save}>Lưu</Button></>}>
        <Field label="Phím tắt" hint="Chữ, số, gạch dưới hoặc gạch ngang. Ví dụ: gia, dia_chi">
          <Input value={edit?.shortcut ?? ''} onChange={(e) => setEdit({ ...edit, shortcut: e.target.value })} />
        </Field>
        <Field label="Tiêu đề">
          <Input value={edit?.title ?? ''} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
        </Field>
        <Field label="Nội dung">
          <Textarea rows={5} value={edit?.body ?? ''} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />
        </Field>
      </Modal>
    </div>
  );
}
