import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppError } from './validation.ts';

export type AttachmentStorage = 'supabase' | 'r2';
export function attachmentStorage(): AttachmentStorage {
  const provider = process.env.CLASSNOTE_ATTACHMENT_STORAGE || 'supabase';
  if (provider !== 'supabase' && provider !== 'r2') throw new AppError('私人附件存储配置无效，请联系网站所有者。', 503);
  if (provider === 'r2') r2Config();
  return provider;
}
export function r2Config() {
  const accountId = process.env.R2_ACCOUNT_ID, bucket = process.env.R2_BUCKET;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID, secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !/^[a-f0-9]{32}$/.test(accountId) || !bucket || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) || !accessKeyId || !secretAccessKey) {
    throw new AppError('R2 私人附件存储尚未配置完成，请联系网站所有者。', 503);
  }
  return { accountId, bucket, accessKeyId, secretAccessKey, endpoint: `https://${accountId}.r2.cloudflarestorage.com` };
}
function client() {
  const config = r2Config();
  return new S3Client({
    region: 'auto', endpoint: config.endpoint, forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  });
}
// R2 credentials bypass database RLS. Never accept an arbitrary database or client-supplied object path.
export function privateObjectPath(owner: string, id: string, index: number) {
  const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
  if (!uuid.test(owner) || !uuid.test(id) || !Number.isSafeInteger(index) || index < 0 || index > 255) throw new AppError('私人附件路径无效', 400);
  return `${owner}/${id}/${index}`;
}
export async function signR2Upload(owner: string, id: string, index: number, size: number, mime: string) {
  const path = privateObjectPath(owner, id, index);
  if (!Number.isSafeInteger(size) || size < 1 || size > 50 * 1024 ** 2) throw new AppError('附件分段大小无效');
  try {
    const url = await getSignedUrl(client(), new PutObjectCommand({
      Bucket: r2Config().bucket, Key: path, ContentType: mime, ContentLength: size,
      IfNoneMatch: '*', CacheControl: 'private, max-age=0',
    }), { expiresIn: 900, signableHeaders: new Set(['content-type', 'content-length', 'if-none-match', 'cache-control']) });
    return { url, path, index, headers: { 'if-none-match': '*', 'cache-control': 'private, max-age=0' } };
  } catch { throw new AppError('暂时无法准备 R2 私有上传，请稍后重试', 503); }
}
export async function r2ObjectUrl(owner: string, id: string, index: number, download?: string) {
  const path = privateObjectPath(owner, id, index);
  try {
    return await getSignedUrl(client(), new GetObjectCommand({
      Bucket: r2Config().bucket, Key: path,
      ...(download ? { ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(download)}` } : {}),
    }), { expiresIn: 60 });
  } catch { throw new AppError('无法读取 R2 私人附件，请稍后重试', 503); }
}
export async function removeR2Objects(owner: string, id: string) {
  const prefix = privateObjectPath(owner, id, 0).replace(/0$/, '');
  const storage = client(), bucket = r2Config().bucket;
  let continuation: string | undefined;
  try {
    do {
      const page = await storage.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuation, MaxKeys: 1000 }));
      const objects = (page.Contents || []).filter(item => item.Key?.startsWith(prefix)).map(item => ({ Key: item.Key! }));
      if (objects.length) {
        const result = await storage.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
        if (result.Errors?.length) throw new Error('Object deletion incomplete');
      }
      continuation = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (page.IsTruncated && !continuation) throw new Error('Invalid storage pagination');
    } while (continuation);
  } catch { throw new AppError('R2 附件未能清理，请稍后重试', 503); }
  finally { storage.destroy(); }
}
