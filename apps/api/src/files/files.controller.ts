import { Controller, Get, Param, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { createHash, randomBytes } from 'crypto';
import { config } from '../config';
import { AccessService } from '../auth/access.service';
import { ADMIN_ROLES, Public, Roles, WRITE_ROLES, Ws, WorkspaceCtx } from '../auth/context';
import { AppError, notFound } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { ALLOWED_MIMES, sniffMatches, StorageService } from './storage.service';

@Controller('files')
export class FilesController {
  constructor(private prisma: PrismaService, private storage: StorageService, private access: AccessService) {}

  @Roles(...WRITE_ROLES)
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024, files: 1 } }))
  async upload(@Ws() ws: WorkspaceCtx, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new AppError('NO_FILE', 'Chưa chọn tệp');
    if (file.size > config().MAX_UPLOAD_MB * 1024 * 1024) throw new AppError('TOO_LARGE', `Tệp vượt quá ${config().MAX_UPLOAD_MB}MB`);
    if (!ALLOWED_MIMES.has(file.mimetype)) throw new AppError('TYPE_NOT_ALLOWED', 'Loại tệp không được phép');
    if (!sniffMatches(file.mimetype, file.buffer)) throw new AppError('TYPE_MISMATCH', 'Nội dung tệp không khớp với định dạng khai báo');
    const safeName = file.originalname.replace(/[\\/\0]/g, '_').slice(0, 200);
    const key = `${ws.workspaceId}/${new Date().toISOString().slice(0, 7)}/${randomBytes(12).toString('hex')}`;
    await this.storage.put(key, file.buffer, file.mimetype);
    const row = await this.prisma.fileObject.create({
      data: { workspaceId: ws.workspaceId, storageKey: key, filename: safeName, mime: file.mimetype, size: file.size, sha256: createHash('sha256').update(file.buffer).digest('hex'), uploadedById: ws.userId },
    });
    return { file: { id: row.id, filename: row.filename, mime: row.mime, size: row.size } };
  }

  /** URL tải có thời hạn — chỉ cấp khi người dùng có quyền với hội thoại chứa tệp (hoặc là quản trị). */
  @Get(':id/url')
  async url(@Ws() ws: WorkspaceCtx, @Param('id') id: string) {
    const file = await this.prisma.fileObject.findFirst({ where: { id, workspaceId: ws.workspaceId } });
    if (!file) throw notFound('Tệp');
    const isAdmin = (ADMIN_ROLES as string[]).includes(ws.role);
    if (!isAdmin && file.uploadedById !== ws.userId) {
      const msg = await this.prisma.message.findFirst({ where: { workspaceId: ws.workspaceId, attachments: { array_contains: [{ fileId: id }] } }, select: { conversationId: true } });
      if (!msg || !(await this.access.canAccessConversation(ws, msg.conversationId))) throw notFound('Tệp');
    }
    return { url: await this.storage.signedUrl(file.storageKey, file.filename, 300), expiresInSec: 300 };
  }

  /** Phục vụ tệp lưu cục bộ qua URL đã ký (dùng khi STORAGE_DRIVER=local). */
  @Public()
  @Get('raw')
  async raw(@Query('key') key: string, @Query('exp') exp: string, @Query('sig') sig: string, @Res() res: Response) {
    if (!key || !this.storage.verifySignature(key, Number(exp), String(sig))) return res.status(403).send('Liên kết đã hết hạn hoặc không hợp lệ');
    const file = await this.prisma.fileObject.findUnique({ where: { storageKey: key } });
    if (!file) return res.status(404).send('Không tìm thấy');
    const data = await this.storage.get(key);
    res.setHeader('Content-Type', file.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `${file.mime.startsWith('image/') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    return res.send(data);
  }
}
