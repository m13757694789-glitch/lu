export class UploadSourceError extends Error {
  constructor(message = '浏览器无法读取原文件。请确认文件已完整保存，重新选择文件后上传。') {
    super(message); this.name = 'UploadSourceError';
  }
}

export function uploadSourceSize(file: Blob): number {
  const size = file.size;
  if (!Number.isSafeInteger(size) || size <= 0) throw new UploadSourceError('没有读取到文件内容（0 字节）。请确认原文件已完整保存，重新选择文件后上传。');
  return size;
}

export async function readUploadBytes(file: Blob, start: number, end: number): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
    if (bytes.length !== end - start) throw new UploadSourceError();
    return bytes;
  } catch (error) {
    if (error instanceof UploadSourceError) throw error;
    throw new UploadSourceError();
  }
}

export async function verifyUploadSource(file: Blob) {
  const size = uploadSourceSize(file);
  await readUploadBytes(file, 0, 1);
  if (size > 1) await readUploadBytes(file, size - 1, size);
  return size;
}
