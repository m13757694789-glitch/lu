import { z } from 'zod';
import { AppError } from './validation.ts';

const schema = z.object({ name:z.string().min(1).max(240), size:z.number().int().positive().max(8*1024**3) });
export function uploadMetadata(input: unknown) {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  if (parsed.error.issues.some(issue=>issue.path[0]==='size')) {
    throw new AppError('没有收到有效的文件大小。文件可能为空或已无法读取，请重新选择文件后上传（单文件最大 8 GB）。');
  }
  throw new AppError('文件名无效，请使用 1–240 个字符的文件名后重新选择文件。');
}
