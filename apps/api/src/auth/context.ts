import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  sessionId: string;
}

export interface WorkspaceCtx {
  workspaceId: string;
  role: Role;
  membershipId: string;
  userId: string;
  isDemo: boolean;
  /** 'all' hoặc danh sách channelId được cấp */
  channelIds: 'all' | string[];
}

export const PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(PUBLIC_KEY, true);

export const ROLES_KEY = 'roles';
/** Vai trò được phép; nếu không khai báo thì mọi thành viên đều được. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export const NO_WORKSPACE_KEY = 'noWorkspace';
export const NoWorkspace = () => SetMetadata(NO_WORKSPACE_KEY, true);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);
export const Ws = createParamDecorator((_: unknown, ctx: ExecutionContext): WorkspaceCtx => ctx.switchToHttp().getRequest().ws);

export const WRITE_ROLES: Role[] = ['OWNER', 'MANAGER', 'AGENT'];
export const ADMIN_ROLES: Role[] = ['OWNER', 'MANAGER'];
