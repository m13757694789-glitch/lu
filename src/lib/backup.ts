import archiver from "archiver";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { createWriteStream } from "node:fs";
import { mkdir, rm, rename, open } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { PassThrough, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { z } from "zod";
import { AppError, courseSchema, lessonSchema, contentSchema, idSchema, type Store } from "./storage.ts";
import type { Attachment } from "./models.ts";
import { mapAttachmentUrls } from "./models.ts";

export function exportBackup(store: Store) {
  const library = store.library(); const attachments = store.db.prepare("SELECT * FROM attachments").all() as Attachment[];
  // Capture metadata before yielding; deleted files are retained so a backup never loses its input midway.
  const paths = attachments.map(file => [file, store.filePath(file)] as const);
  const archive = archiver("zip", { zlib: { level: 0 } }); const stream = new PassThrough();
  archive.on("error", error => stream.destroy(error)); archive.on("warning", error => stream.destroy(error)); archive.pipe(stream);
  archive.append(JSON.stringify({ format: "classnote", version: 1, exportedAt: new Date().toISOString(), ...library, attachments }), { name: "manifest.json" });
  for (const [file, path] of paths) archive.file(path, { name: `files/${file.filename}` });
  void archive.finalize().catch(error => stream.destroy(error));
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="classnote-backup-${new Date().toISOString().slice(0, 10)}.zip"`, "Cache-Control": "no-store" } });
}

import { manifestSchema, type Manifest } from "./backup-schema.ts";
function zipOpen(path: string): Promise<ZipFile> { return new Promise((resolve, reject) => yauzl.open(path, { lazyEntries: true, validateEntrySizes: true, autoClose: false }, (error, zip) => error || !zip ? reject(error || new AppError("备份无法打开")) : resolve(zip))); }
function entryStream(zip: ZipFile, entry: Entry): Promise<Readable> { return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error || !stream ? reject(error || new Error("缺少文件流")) : resolve(stream))); }

export async function restoreBackup(request: Request, store: Store) {
  if (!request.body) throw new AppError("备份内容为空");
  const directory = join(store.temporary, `restore-${randomUUID()}`); await mkdir(directory);
  const zipPath = join(directory, "backup.zip"); const moved: string[] = []; let zip: ZipFile | undefined;
  try {
    let size = 0;
    await pipeline(Readable.fromWeb(request.body as NodeReadableStream<Uint8Array>), new Transform({ transform(chunk: Buffer, _encoding, done) { size += chunk.length; if (size > 64 * 1024 ** 3) done(new AppError("备份超过 64 GB 限制")); else done(null, chunk); } }), createWriteStream(zipPath, { flags: "wx" }), { signal: request.signal });
    zip = await zipOpen(zipPath); const currentZip = zip;
    let manifest: Manifest | undefined; const extracted = new Set<string>(); const seen = new Set<string>(); let entries = 0;
    await new Promise<void>((resolve, reject) => {
      currentZip.on("error", reject); currentZip.on("end", resolve);
      currentZip.on("entry", (entry: Entry) => { void (async () => {
        if (++entries > 100002 || seen.has(entry.fileName) || entry.isEncrypted()) throw new AppError("备份包含重复、加密或过多文件"); seen.add(entry.fileName);
        if (entry.fileName === "manifest.json") {
          if (manifest || entry.uncompressedSize > 32 * 1024 ** 2) throw new AppError("备份清单过大或重复");
          const chunks: Buffer[] = []; const stream = await entryStream(currentZip, entry); let bytes = 0;
          for await (const chunk of stream) { bytes += chunk.length; if (bytes > 32 * 1024 ** 2) throw new AppError("备份清单过大"); chunks.push(chunk); }
          try { manifest = manifestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { throw new AppError("备份清单无效或版本不受支持"); }
          const courses = new Set(manifest.courses.map(course => course.id)); const lessons = new Set(manifest.lessons.map(lesson => lesson.id)); const files = new Set(manifest.attachments.map(file => file.id)); const names = new Set(manifest.attachments.map(file => file.filename));
          if (courses.size !== manifest.courses.length || lessons.size !== manifest.lessons.length || files.size !== manifest.attachments.length || names.size !== manifest.attachments.length || manifest.lessons.some(lesson => !courses.has(lesson.courseId)) || manifest.attachments.some(file => !lessons.has(file.lessonId))) throw new AppError("备份的数据关联或 ID 无效");
        } else {
          if (entry.fileName === "files/") { currentZip.readEntry(); return; }
          if (!manifest) throw new AppError("备份清单必须在附件之前");
          const attachment = manifest.attachments.find(file => `files/${file.filename}` === entry.fileName);
          if (!attachment || entry.uncompressedSize !== attachment.size) throw new AppError("备份包含未知路径或文件大小不符");
          const hash = createHash("sha256"); let bytes = 0;
          await pipeline(await entryStream(currentZip, entry), new Transform({ transform(chunk: Buffer, _encoding, done) { bytes += chunk.length; if (bytes > attachment.size) return done(new AppError("附件解压超出预期大小")); hash.update(chunk); done(null, chunk); } }), createWriteStream(join(directory, attachment.filename), { flags: "wx" }));
          if (bytes !== attachment.size || hash.digest("hex") !== attachment.sha256) throw new AppError("附件校验失败，备份可能损坏");
          const handle = await open(join(directory, attachment.filename), "r+"); try { await handle.sync(); } finally { await handle.close(); }
          extracted.add(attachment.id);
        }
        currentZip.readEntry();
      })().catch(reject); });
      currentZip.readEntry();
    });
    zip.close(); zip = undefined;
    const data = manifest as Manifest | undefined;
    if (!data || extracted.size !== data.attachments.length) throw new AppError("备份缺少清单或附件");
    const ids = new Map([...data.courses, ...data.lessons, ...data.attachments].map(item => [item.id, randomUUID()]));
    const newFiles = data.attachments.map(file => ({ ...file, id: ids.get(file.id)!, lessonId: ids.get(file.lessonId)!, filename: ids.get(file.id)! + file.filename.slice(file.filename.lastIndexOf(".")) }));
    const contents = data.lessons.map(lesson => JSON.stringify(mapAttachmentUrls(lesson.content, id => {
      const file = data.attachments.find(file => file.id === id && file.lessonId === lesson.id); if (!file) throw new AppError("正文引用了缺失或不属于该课堂的附件"); return ids.get(id)!;
    })));
    for (let index = 0; index < newFiles.length; index++) { const target = join(store.files, newFiles[index].filename); await rename(join(directory, data.attachments[index].filename), target); moved.push(target); }
    store.transaction(() => {
      for (const course of data.courses) store.db.prepare("INSERT INTO courses VALUES(?,?,?,?,?,?)").run(ids.get(course.id)!, course.name, course.color, course.description, course.archived, course.createdAt);
      for (let index = 0; index < data.lessons.length; index++) { const lesson = data.lessons[index]; store.db.prepare("INSERT INTO lessons VALUES(?,?,?,?,?,0,?,?,?)").run(ids.get(lesson.id)!, ids.get(lesson.courseId)!, lesson.title, lesson.date, contents[index], lesson.createdAt, lesson.updatedAt, lesson.visitedAt); }
      for (const file of newFiles) store.addAttachment(file);
    });
    moved.length = 0;
    return { courses: data.courses.length, lessons: data.lessons.length, attachments: data.attachments.length };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("备份读取或恢复失败。原有知识库未被覆盖；请检查备份文件和磁盘空间。");
  } finally {
    zip?.close(); await Promise.all(moved.map(path => rm(path, { force: true }))); await rm(directory, { recursive: true, force: true });
  }
}
