import type { Metadata } from "next";
import "@blocknote/mantine/style.css";
import "katex/dist/katex.min.css";
import "./globals.css";
export const metadata: Metadata = {
  title: "ClassNote · 课堂知识库",
  description: "留住课堂里的每一次理解。你的私人课程、录音与学习笔记。",
  robots: { index: false, follow: false },
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="zh-CN" data-theme="dark" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: `try{document.documentElement.dataset.theme=localStorage.getItem("classnote-theme")==="light"?"light":"dark"}catch(e){document.documentElement.dataset.theme="dark"}` }} /></head><body>{children}</body></html>;
}
