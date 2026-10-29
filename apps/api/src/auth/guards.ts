import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { config } from '../config';
import { AppError, forbidden } from '../common/errors';
import { AuthService } from './auth.service';
import { NO_WORKSPACE_KEY, PUBLIC_KEY, ROLES_KEY } from './context';

export const SESSION_COOKIE = 'omni_session';

/** Xác thực phiên + nạp ngữ cảnh workspace + kiểm tra vai trò. Áp dụng toàn cục. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;
    const req = context.switchToHttp().getRequest();

    // Chống CSRF: request thay đổi dữ liệu phải đến từ origin được phép
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin as string | undefined;
      const allowed = config().CORS_ORIGINS.split(',').map((s) => s.trim());
      if (origin && !allowed.includes(origin)) throw forbidden('Nguồn yêu cầu không hợp lệ');
    }

    const user = await this.auth.validateSession(req.cookies?.[SESSION_COOKIE]);
    if (!user) throw new AppError('UNAUTHENTICATED', 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.', 401);
    req.user = user;

    if (this.reflector.getAllAndOverride<boolean>(NO_WORKSPACE_KEY, targets)) return true;
    const workspaceId = req.headers['x-workspace-id'] as string | undefined;
    if (!workspaceId) throw new AppError('WORKSPACE_REQUIRED', 'Thiếu workspace', 400);
    const ws = await this.auth.workspaceContext(user.id, workspaceId);
    if (!ws) throw forbidden('Bạn không thuộc workspace này');
    req.ws = ws;

    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, targets);
    if (roles && roles.length && !roles.includes(ws.role)) throw forbidden();
    // Người xem chỉ được đọc
    if (ws.role === 'VIEWER' && !['GET', 'HEAD'].includes(req.method)) throw forbidden('Vai trò Người xem chỉ được xem dữ liệu');
    return true;
  }
}
