import { downloadText } from "./client";
const errorKey = "classnote-last-ui-error";
export function recordUIError(error: unknown) {
  try {
    const value = error instanceof Error ? error : new Error("页面操作发生异常");
    // Diagnostics stay in this browser. Strip URLs and credential-shaped values; never include note contents.
    const clean = (text: string) => text.replace(/https?:\/\/[^\s)]+/g, "[网页地址]").replace(/Bearer\s+\S+|sb_(?:secret|publishable)_\S+|eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[已隐藏]").slice(0,3000);
    const safeMessage = /^(Cannot (?:read|set)|Maximum update depth|Minified React error|Failed to execute|Rendered (?:more|fewer)|Objects are not valid|Loading chunk|Failed to fetch dynamically)/.test(value.message) ? clean(value.message.slice(0,500)) : "页面脚本异常，请结合调用位置排查";
    const stack = (value.stack || "").split("\n").filter(line => /^\s*at\s/.test(line)).slice(0,10).join("\n");
    sessionStorage.setItem(errorKey, JSON.stringify({ time: new Date().toISOString(), name: /^[a-zA-Z][a-zA-Z0-9]{0,64}$/.test(value.name) ? value.name : "Error", message: safeMessage, stack: clean(stack) }));
  } catch {}
}
export function exportUIError() { downloadText("ClassNote-页面错误信息.json", sessionStorage.getItem(errorKey) || JSON.stringify({message:"当前浏览器没有记录到页面错误"}), "application/json"); }
export function hasUIError() { try { return typeof window !== "undefined" && !!sessionStorage.getItem(errorKey); } catch { return false; } }
export function exportRecoveryDrafts() {
  const drafts: Record<string, unknown> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i); if (!key?.startsWith("classnote-draft-")) continue;
    const raw = localStorage.getItem(key); if (raw) { try { drafts[key] = JSON.parse(raw); } catch { drafts[key] = raw; } }
  }
  downloadText("ClassNote-浏览器恢复草稿.json", JSON.stringify(drafts, null, 2), "application/json");
}
