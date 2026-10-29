import { HttpException, HttpStatus } from '@nestjs/common';

/** Lỗi nghiệp vụ có mã và thông điệp tiếng Việt cho người dùng. */
export class AppError extends HttpException {
  constructor(public readonly code: string, message: string, status: number = HttpStatus.BAD_REQUEST, extra?: Record<string, unknown>) {
    super({ code, message, ...extra }, status);
  }
}

export const notFound = (what = 'Dữ liệu') => new AppError('NOT_FOUND', `${what} không tồn tại hoặc bạn không có quyền truy cập`, 404);
export const forbidden = (msg = 'Bạn không có quyền thực hiện thao tác này') => new AppError('FORBIDDEN', msg, 403);
