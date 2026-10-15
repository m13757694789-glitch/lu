import type { Attachment } from "./models";
export async function api<T>(path: string, method = "GET", data?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, { method, headers: data === undefined ? undefined : { "Content-Type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data), cache: "no-store" });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || "操作失败，请重试"); return result as T;
}
export function uploadFile<T = Attachment>(path: string, file: File, progress: (value: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); xhr.open("POST", `/api/${path}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream"); xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name)); xhr.setRequestHeader("x-file-size", String(file.size));
    xhr.upload.onprogress = event => { if (event.lengthComputable) progress(Math.min(99, Math.round(event.loaded / event.total * 100))); };
    xhr.onerror = () => reject(new Error("上传中断，请检查本机服务是否运行")); xhr.onabort = () => reject(new Error("上传已取消"));
    xhr.onload = () => { try { const result = JSON.parse(xhr.responseText); if (xhr.status >= 200 && xhr.status < 300) { progress(100); resolve(result); } else reject(new Error(result.error || "上传失败")); } catch { reject(new Error("上传返回了无效响应")); } };
    xhr.send(file);
  });
}
export function downloadText(name: string, text: string, type = "text/plain;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type })); const link = document.createElement("a"); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const bytes = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(value / 1024)} KB`;
export const localDate = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
