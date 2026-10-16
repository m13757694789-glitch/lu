"use client";
import { useEffect } from "react";
import { exportRecoveryDrafts, exportUIError, recordUIError } from "@/lib/ui-recovery";
export default function ErrorPage({error,reset}:{error:Error;reset:()=>void}) {
  useEffect(()=>recordUIError(error),[error]);
  return <main className="workspace-recovery"><div><h1>页面暂时遇到了问题</h1><p>已保存的笔记和录音不会被这次错误清空。<br />可以先导出恢复草稿，再重试打开页面。</p><div><button className="secondary-button" onClick={()=>{try{exportRecoveryDrafts();}catch{alert("浏览器暂时无法读取恢复草稿，请保留此页面后重试。");}}}>导出恢复草稿</button><button className="secondary-button" onClick={exportUIError}>导出错误信息</button><button className="primary-button" onClick={reset}>重试打开</button></div></div></main>;
}
