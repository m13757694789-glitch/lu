"use client";
import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, uploadFile } from "@/lib/client";
import { exportRecoveryDrafts, exportUIError, recordUIError } from "@/lib/ui-recovery";
import { AudioUploadQueue } from "@/lib/audio-upload-queue";
import AudioUploadPanel from "./audio-upload-panel";
import Workspace from "./workspace";

class WorkspaceBoundary extends Component<{ children: ReactNode; retry: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { recordUIError(error); console.error("ClassNote workspace error:", error); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="workspace-recovery"><div><h1>页面暂时遇到了问题</h1><p>已保存的资料不会被清空，录音上传任务仍保留在下方。<br />可以先导出浏览器中的恢复草稿，再重新打开学习空间。</p><div><button className="secondary-button" onClick={() => { try { exportRecoveryDrafts(); } catch { alert("浏览器暂时无法读取恢复草稿，请保留此页面后重试。"); } }}>导出恢复草稿</button><button className="secondary-button" onClick={exportUIError}>导出错误信息</button><button className="primary-button" onClick={this.props.retry}>重新打开学习空间</button></div></div></main>;
  }
}

export default function WorkspaceSession(props: { cloud: boolean; email?: string; onLogout: () => void }) {
  const [audioUploads] = useState(() => new AudioUploadQueue(
    (lessonId, file, progress) => uploadFile(`lessons/${lessonId}/attachments`, file, progress),
    async id => { await api(`files/${id}`, "DELETE"); },
  ));
  const [epoch, setEpoch] = useState(0);
  const open = useRef<((id: string) => void) | null>(null);
  const register = useCallback((handler: ((id: string) => void) | null) => { open.current = handler; }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (audioUploads.hasPending()) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [audioUploads]);
  return <><WorkspaceBoundary key={epoch} retry={() => setEpoch(value => value + 1)}><Workspace {...props} audioUploads={audioUploads} onOpenLessonReady={register} /></WorkspaceBoundary><AudioUploadPanel queue={audioUploads} openLesson={id => {
    if (open.current) open.current(id);
    else { window.history.replaceState({}, "", `?lesson=${id}`); setEpoch(value => value + 1); }
  }} /></>;
}
