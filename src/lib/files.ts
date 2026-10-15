import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm, open } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { AppError, type Store } from "./storage.ts";
import type { Attachment } from "./models.ts";

const types: Record<string, ["audio" | "image", string]> = {
  ".mp3": ["audio", "audio/mpeg"], ".m4a": ["audio", "audio/mp4"], ".wav": ["audio", "audio/wav"],
  ".ogg": ["audio", "audio/ogg"], ".oga": ["audio", "audio/ogg"], ".opus": ["audio", "audio/ogg"],
  ".aac": ["audio", "audio/aac"], ".flac": ["audio", "audio/flac"], ".webm": ["audio", "audio/webm"],
  ".jpg": ["image", "image/jpeg"], ".jpeg": ["image", "image/jpeg"], ".png": ["image", "image/png"], ".webp": ["image", "image/webp"], ".gif": ["image", "image/gif"],
};
export async function upload(request: Request, store: Store, lessonId: string) {
  store.lesson(lessonId);
  let name: string; try { name = decodeURIComponent(request.headers.get("x-file-name") || ""); } catch { throw new AppError("文件名编码无效"); }
  if (!name || name.length > 240) throw new AppError("文件名为空或过长");
  const extension = extname(name).toLowerCase(); const type = types[extension];
  if (!type) throw new AppError("不支持这个格式。请上传 MP3、M4A、WAV 等音频，或 JPG、PNG、WEBP、GIF 图片。");
  const max = type[0] === "image" ? 50 * 1024 ** 2 : 8 * 1024 ** 3;
  const expected = Number(request.headers.get("x-file-size"));
  if (!Number.isSafeInteger(expected) || expected < 1 || expected > max) throw new AppError(type[0] === "image" ? "图片须小于 50 MB" : "录音须小于 8 GB");
  if (!request.body) throw new AppError("没有收到文件内容");
  const id = randomUUID(); const filename = id + extension; const temporary = join(store.temporary, id + ".part"); const path = join(store.files, filename);
  let size = 0; const hash = createHash("sha256"); let head = Buffer.alloc(0);
  const count = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    size += chunk.length; if (size > expected || size > max) return callback(new AppError("文件大小超出限制"));
    if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
    hash.update(chunk); callback(null, chunk);
  } });
  try {
    await pipeline(Readable.fromWeb(request.body as NodeReadableStream<Uint8Array>), count, createWriteStream(temporary, { flags: "wx" }), { signal: request.signal });
    if (size !== expected) throw new AppError("文件传输不完整，请重试");
    if (type[0] === "image") {
      const valid = type[1] === "image/png" ? head.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : type[1] === "image/jpeg" ? head[0] === 255 && head[1] === 216 && head[2] === 255 : type[1] === "image/webp" ? head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP" : /^GIF8[79]a/.test(head.toString("ascii"));
      if (!valid) throw new AppError("文件内容与图片格式不符");
    }
    const handle = await open(temporary, "r+"); try { await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
    return store.addAttachment({ id, filename, lessonId, name, kind: type[0], mime: type[1], size, sha256: hash.digest("hex"), position: 0, createdAt: new Date().toISOString() });
  } catch (error) {
    await rm(temporary, { force: true }); await rm(path, { force: true }); throw error;
  }
}
export function serveFile(request: Request, store: Store, attachment: Attachment) {
  const path = store.filePath(attachment); const headers = new Headers({ "Content-Type": attachment.mime, "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store" });
  const download = new URL(request.url).searchParams.has("download");
  headers.set("Content-Disposition", `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`);
  let start = 0, end = attachment.size - 1, status = 200; const range = request.headers.get("range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${attachment.size}` } });
    if (!match[1]) start = Math.max(0, attachment.size - Number(match[2])); else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= attachment.size || start < 0) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${attachment.size}` } });
    status = 206; headers.set("Content-Range", `bytes ${start}-${end}/${attachment.size}`);
  }
  headers.set("Content-Length", String(end - start + 1));
  if (request.method === "HEAD") return new Response(null, { status, headers });
  const stream = createReadStream(path, { start, end });
  request.signal.addEventListener("abort", () => stream.destroy(), { once: true });
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers });
}
