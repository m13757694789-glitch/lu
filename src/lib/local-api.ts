import { z } from "zod";
import { getStore, AppError, idSchema } from "./storage.ts";
import { upload, serveFile } from "./files.ts";
import { exportBackup, restoreBackup } from "./backup.ts";

function guard(request: Request) {
  const host = request.headers.get("host") || "";
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) throw new AppError("本机版本仅接受本机访问", 403);
  const origin = request.headers.get("origin");
  if (origin && origin !== `http://${host}`) throw new AppError("不允许跨站访问私人知识库", 403);
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new AppError("不允许跨站请求", 403);
}
async function json(request: Request) {
  if (!request.body) throw new AppError("请求内容为空"); const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 8 * 1024 ** 2) { await reader.cancel(); throw new AppError("笔记内容过大（最多 8 MB）", 413); } chunks.push(part.value); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new AppError("JSON 格式无效"); }
}
export async function handleLocal(request: Request) {
  try {
    guard(request); const store = getStore(); const segments = new URL(request.url).pathname.split("/").filter(Boolean).slice(1); const [resource, id, action] = segments; const method = request.method;
    if (id) idSchema.parse(id);
    let result: unknown;
    if (method === "GET" && resource === "library" && !id) result = store.library();
    else if (method === "GET" && resource === "health" && !id) result = { app: "ClassNote", version: "1.0.0", storage: "sqlite-local-files", instance: process.env.CLASSNOTE_INSTANCE_ID || "manual" };
    else if (method === "GET" && resource === "backup-check" && !id) { for (const file of store.db.prepare("SELECT id FROM attachments").all()) store.filePath(store.attachment(file.id as string)); result = { ok: true }; }
    else if (method === "GET" && resource === "lessons" && id) result = store.detail(id, new URL(request.url).searchParams.get('prefetch') !== '1');
    else if (method === "POST" && resource === "lessons" && id && action === 'visit') { const lesson=store.detail(id,true);store.settings({lastLesson:id});result={visitedAt:lesson.visitedAt}; }
    else if ((method === "GET" || method === "HEAD") && resource === "files" && id) return serveFile(request, store, store.attachment(id));
    else if (method === "GET" && resource === "backup" && !id) return exportBackup(store);
    else if (method === "POST" && resource === "restore" && !id) result = await restoreBackup(request, store);
    else if (method === "POST" && resource === "courses" && !id) result = store.createCourse(await json(request));
    else if (method === "POST" && resource === "lessons" && !id) result = store.createLesson(await json(request));
    else if (method === "POST" && resource === "lessons" && id && action === "attachments") result = await upload(request, store, id);
    else if (method === "PATCH" && resource === "courses" && id) result = store.updateCourse(id, await json(request));
    else if (method === "PATCH" && resource === "lessons" && id) result = store.updateLesson(id, await json(request));
    else if (method === "PATCH" && resource === "files" && id) result = store.updateAttachment(id, await json(request));
    else if (method === "PATCH" && resource === "settings" && !id) { store.settings(await json(request)); result = { ok: true }; }
    else if (method === "DELETE" && resource === "courses" && id) { store.deleteCourse(id); result = { ok: true }; }
    else if (method === "DELETE" && resource === "lessons" && id) { store.deleteLesson(id); result = { ok: true }; }
    else if (method === "DELETE" && resource === "files" && id) { store.deleteAttachment(id); result = { ok: true }; }
    else throw new AppError("接口不存在", 404);
    return Response.json(result, { status: method === "POST" ? 201 : 200, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) {
    const validation = error instanceof z.ZodError;
    const status = error instanceof AppError ? error.status : validation ? 400 : 500;
    if (status === 500) console.error("ClassNote storage error:", error);
    return Response.json({ error: error instanceof AppError ? error.message : validation ? "输入格式不正确，请检查名称、日期或笔记结构" : "本机存储写入或读取失败，请检查磁盘空间和文件权限" }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
