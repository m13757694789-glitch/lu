import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { AppError } from "./validation.ts";

export function cloudConfig() {
  const url = process.env.SUPABASE_URL; const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  const owner = process.env.CLASSNOTE_OWNER_EMAIL?.toLowerCase();
  if (!url || !key || !owner) throw new AppError("线上登录和私有存储尚未配置完成，请联系网站所有者。", 503);
  return { url, key, owner, bucket: "classnote-private" };
}
export async function cloudClient() {
  const config = cloudConfig(); const jar = await cookies();
  return createServerClient(config.url, config.key, {
    cookieOptions: { httpOnly: true, sameSite: "lax", secure: process.env.CLASSNOTE_ORIGIN?.startsWith("https:"), path: "/" },
    cookies: { getAll: () => jar.getAll(), setAll: entries => { for (const entry of entries) jar.set(entry.name, entry.value, entry.options); } },
    global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }) },
  });
}
export async function requireOwner(client: Awaited<ReturnType<typeof cloudClient>>) {
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new AppError("登录已过期，请重新登录。未保存的内容仍保留在当前页面。", 401);
  if (!data.user.email_confirmed_at || data.user.email?.toLowerCase() !== cloudConfig().owner) throw new AppError("此账号没有访问这个私人知识库的权限", 403);
  return data.user;
}
