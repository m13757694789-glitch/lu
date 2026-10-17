"use client";
import { useState, useSyncExternalStore } from "react";
import { Check, ChevronDown, ChevronUp, LoaderCircle, RotateCcw, X } from "lucide-react";
import { AudioUploadQueue } from "@/lib/audio-upload-queue";
import { bytes } from "@/lib/client";
import type { AudioUploadTask } from "@/lib/audio-upload-queue";

function taskState(task: AudioUploadTask) {
  if (task.status === "queued") return "等待上传";
  if (task.status === "completed") return "已上传";
  if (task.status === "failed") return task.error;
  const transfer = task.transfer;
  if (!transfer) return `${task.progress}%`;
  if (transfer.stage === "preparing") return "正在准备并校验文件…";
  if (transfer.stage === "saving") return "正在保存录音…";
  if (transfer.stage === "verifying") return "已传输，正在云端校验…";
  if (transfer.stage === "retrying") return "连接中断，正在重试当前分段…";
  return `${task.progress}% · ${bytes(transfer.loaded)} / ${bytes(transfer.total)}${transfer.bytesPerSecond && transfer.bytesPerSecond >= 1024 ? ` · ${bytes(transfer.bytesPerSecond)}/秒` : ""}`;
}

export default function AudioUploadPanel({ queue, openLesson }: { queue: AudioUploadQueue; openLesson: (id: string) => void }) {
  const tasks = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getServerSnapshot);
  const [collapsed, setCollapsed] = useState(false);
  if (!tasks.length) return null;
  const pending = tasks.filter(task => task.status === "queued" || task.status === "uploading").length;
  return <section className="audio-upload-panel" aria-label="录音上传任务">
    <div className="upload-panel-heading"><button type="button" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}><strong>录音上传{pending ? ` · ${pending} 份进行中` : ""}</strong>{collapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</button>{tasks.some(task => task.status === "completed") && <button className="text-button" onClick={() => queue.clearCompleted()}>清除已完成</button>}</div>
    {!collapsed && <><p className="upload-panel-hint">可切换课堂，请保持本页打开。</p><div className="upload-task-list">{tasks.map(task => <div className={`upload-task ${task.status}`} key={task.id}>
      <div className="upload-task-title"><span title={task.name}>{task.name}</span>{task.status === "completed" ? <Check size={15} /> : task.status === "uploading" ? <LoaderCircle size={15} className="spin" /> : null}</div>
      <button className="upload-task-lesson" onClick={() => openLesson(task.lessonId)} title="打开所属课堂">{task.lessonTitle}</button>
      <div className="upload-task-state" role="status">{taskState(task)}</div>
      {task.status === "uploading" && <progress aria-label={`${task.name}上传进度`} max={100} value={task.progress} />}
      {task.warning && <p className="inline-error">{task.warning}</p>}
      {task.status === "failed" && <div className="upload-task-actions"><button className="text-button" onClick={() => queue.retry(task.id)}><RotateCcw size={13} />重试</button><button className="text-button" onClick={() => queue.dismiss(task.id)}><X size={13} />移除失败任务</button></div>}
    </div>)}</div></>}
  </section>;
}
