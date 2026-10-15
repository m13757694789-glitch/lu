import { AppError } from "./validation.ts";

export function storageMode(request: Request): "local" | "cloud" {
  if (process.env.CLASSNOTE_STORAGE === "cloud") return "cloud";
  const hostname = new URL(request.url).hostname;
  if (["127.0.0.1", "localhost", "[::1]"].includes(hostname)) return "local";
  throw new AppError("线上私有存储尚未配置完成，请联系网站所有者。", 503);
}
export function guardCloud(request: Request) {
  const url = new URL(request.url); const configured = process.env.CLASSNOTE_ORIGIN;
  if (!configured || url.origin !== configured) throw new AppError("网站访问地址不匹配", 403);
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new AppError("不允许跨站访问私人知识库", 403);
  const origin = request.headers.get("origin");
  if (origin && origin !== configured) throw new AppError("不允许跨站访问私人知识库", 403);
  if (url.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(url.hostname)) throw new AppError("请通过 HTTPS 访问", 403);
}
export async function readJson(request: Request, maximum = 4 * 1024 ** 2) {
  if (!request.body) throw new AppError("请求内容为空");
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > maximum) { await reader.cancel(); throw new AppError("请求内容过大，请减少本次笔记内容", 413); } chunks.push(part.value); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new AppError("请求格式无效"); }
}
export async function handleRequest(request: Request) {
  try {
    const mode = storageMode(request);
    if (mode === "cloud") {
      guardCloud(request);
      const { handleCloud } = await import("./cloud-api.ts");
      return await handleCloud(request);
    }
    if (new URL(request.url).pathname === "/api/session") return Response.json({ mode: "local", authenticated: true }, { headers: { "Cache-Control": "no-store" } });
    const { handleLocal } = await import("./local-api.ts");
    return await handleLocal(request);
  } catch (error) {
    const status = error instanceof AppError ? error.status : 500;
    return Response.json({ error: error instanceof AppError ? error.message : "服务暂时无法响应，请稍后重试。" }, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }
}
