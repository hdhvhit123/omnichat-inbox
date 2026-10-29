import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/** Trả lỗi dạng {code, message} tiếng Việt; không lộ chi tiết nội bộ. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('Error');
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'object' && (body as any).code) return res.status(status).json(body);
      const map: Record<number, string> = { 404: 'Không tìm thấy', 413: 'Tệp quá lớn', 401: 'Chưa đăng nhập', 403: 'Không có quyền' };
      return res.status(status).json({ code: `HTTP_${status}`, message: map[status] ?? (typeof body === 'string' ? body : (body as any).message) ?? 'Lỗi' });
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError && exception.code === 'P2025') {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Dữ liệu không tồn tại' });
    }
    this.log.error(exception instanceof Error ? exception.stack : String(exception));
    return res.status(500).json({ code: 'INTERNAL', message: 'Lỗi hệ thống. Vui lòng thử lại.' });
  }
}
