import { Injectable, Logger } from '@nestjs/common';
import { KnowledgeSource, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { normalizeVi } from '../common/text';
import { PrismaService } from '../common/prisma.service';
import { QUEUES, QueueService } from '../common/queue.service';
import { StorageService } from '../files/storage.service';

const STOPWORDS = new Set(
  'a ah ak anh chi em cho hoi la co khong ko k nhe nha vay the nao gi oi shop ban minh toi duoc voi va cua thi ma nay do roi ah u uh vang da dc j ve o tai cai nhung cac mot hay lam'.split(' '),
);

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  title: string;
  version: number;
  content: string;
  rank: number;
}

@Injectable()
export class KnowledgeService {
  private readonly log = new Logger('Knowledge');
  constructor(private prisma: PrismaService, private queue: QueueService, private storage: StorageService) {}

  register() {
    this.queue.register(QUEUES.knowledge, (d: { documentId: string }) => this.process(d.documentId));
  }

  async create(workspaceId: string, userId: string, input: { title: string; sourceType: KnowledgeSource; rawText?: string; fileId?: string; groupId?: string }) {
    let version = 1;
    let groupId = input.groupId ?? randomUUID();
    if (input.groupId) {
      const last = await this.prisma.knowledgeDocument.findFirst({ where: { workspaceId, groupId: input.groupId }, orderBy: { version: 'desc' } });
      if (!last) throw new Error('Tài liệu gốc không tồn tại');
      version = last.version + 1;
      groupId = last.groupId;
    }
    const doc = await this.prisma.knowledgeDocument.create({
      data: { workspaceId, groupId, version, title: input.title, sourceType: input.sourceType, rawText: input.rawText, fileId: input.fileId, createdById: userId },
    });
    await this.queue.add(QUEUES.knowledge, { documentId: doc.id }, { jobId: `kb-${doc.id}`, attempts: 2 });
    return doc;
  }

  async process(documentId: string) {
    const doc = await this.prisma.knowledgeDocument.findUnique({ where: { id: documentId } });
    if (!doc || doc.status === 'READY' || doc.status === 'ARCHIVED') return;
    await this.prisma.knowledgeDocument.update({ where: { id: doc.id }, data: { status: 'PROCESSING', error: null } });
    try {
      let text = doc.rawText ?? '';
      if (doc.sourceType === 'PDF' || doc.sourceType === 'DOCX') {
        const file = await this.prisma.fileObject.findFirstOrThrow({ where: { id: doc.fileId!, workspaceId: doc.workspaceId } });
        const buf = await this.storage.get(file.storageKey);
        if (doc.sourceType === 'PDF') {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const pdfParse = require('pdf-parse/lib/pdf-parse.js');
          text = (await pdfParse(buf)).text;
        } else {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const mammoth = require('mammoth');
          text = (await mammoth.extractRawText({ buffer: buf })).value;
        }
      }
      const chunks = chunkText(text, doc.sourceType);
      if (!chunks.length) throw new Error('Không trích xuất được nội dung văn bản (tệp có thể là ảnh scan hoặc rỗng)');
      await this.prisma.$transaction([
        this.prisma.knowledgeChunk.deleteMany({ where: { documentId: doc.id } }),
        this.prisma.knowledgeChunk.createMany({
          data: chunks.map((c, i) => ({ workspaceId: doc.workspaceId, documentId: doc.id, ordinal: i, content: c, normalized: normalizeVi(`${doc.title} ${c}`) })),
        }),
        this.prisma.knowledgeDocument.update({ where: { id: doc.id }, data: { status: 'READY', rawText: doc.sourceType === 'PDF' || doc.sourceType === 'DOCX' ? text.slice(0, 200_000) : undefined } }),
      ]);
    } catch (e: any) {
      this.log.warn(`Nhập tài liệu ${doc.id} lỗi: ${e.message}`);
      await this.prisma.knowledgeDocument.update({ where: { id: doc.id }, data: { status: 'FAILED', error: String(e.message).slice(0, 500) } });
    }
  }

  /** Duyệt một phiên bản: phiên bản khác cùng nhóm bị lưu trữ. */
  async approve(workspaceId: string, id: string, approved: boolean) {
    const doc = await this.prisma.knowledgeDocument.findFirstOrThrow({ where: { id, workspaceId } });
    if (approved && doc.status !== 'READY') throw new Error('Chỉ duyệt được tài liệu đã xử lý xong');
    await this.prisma.$transaction(async (tx) => {
      if (approved) {
        await tx.knowledgeDocument.updateMany({ where: { workspaceId, groupId: doc.groupId, id: { not: doc.id }, status: 'READY' }, data: { status: 'ARCHIVED', approved: false } });
      }
      await tx.knowledgeDocument.update({ where: { id: doc.id }, data: { approved } });
    });
  }

  /** Tìm kiếm toàn văn trên tài liệu ĐÃ DUYỆT của workspace (chuẩn hoá bỏ dấu). */
  async search(workspaceId: string, query: string, limit = 4): Promise<RetrievedChunk[]> {
    const tokens = [...new Set(normalizeVi(query).split(' ').filter((t) => t.length > 1 && !STOPWORDS.has(t) && /^[a-z0-9]+$/.test(t)))].slice(0, 12);
    if (!tokens.length) return [];
    const tsq = tokens.join(' | ');
    const rows = await this.prisma.$queryRaw<RetrievedChunk[]>(Prisma.sql`
      SELECT c.id AS "chunkId", d.id AS "documentId", d.title, d.version, c.content,
             ts_rank(to_tsvector('simple', c.normalized), to_tsquery('simple', ${tsq}))::float AS rank
      FROM "KnowledgeChunk" c JOIN "KnowledgeDocument" d ON d.id = c."documentId"
      WHERE c."workspaceId" = ${workspaceId} AND d.approved = true AND d.status = 'READY'
        AND to_tsvector('simple', c.normalized) @@ to_tsquery('simple', ${tsq})
      ORDER BY rank DESC LIMIT ${limit}`);
    return rows;
  }
}

export function chunkText(text: string, sourceType: KnowledgeSource, max = 800): string[] {
  const clean = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  // FAQ: mỗi cặp Hỏi/Đáp là một đoạn
  if (sourceType === 'FAQ') {
    const parts = clean.split(/\n(?=(?:Q|Hỏi)\s*:)/i).map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) return parts.map((p) => p.slice(0, 2000));
  }
  const paras = clean.split(/\n\s*\n/);
  const out: string[] = [];
  let cur = '';
  for (const p of paras) {
    if ((cur + '\n\n' + p).length > max && cur) {
      out.push(cur.trim());
      cur = p;
    } else cur = cur ? `${cur}\n\n${p}` : p;
    while (cur.length > max * 1.5) {
      out.push(cur.slice(0, max));
      cur = cur.slice(max);
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
