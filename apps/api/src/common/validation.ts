import { z, ZodTypeAny } from 'zod';
import { AppError } from './errors';

export function parse<S extends ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new AppError('VALIDATION', `Dữ liệu không hợp lệ: ${first.path.join('.') || 'body'} — ${first.message}`, 400);
  }
  return r.data;
}
