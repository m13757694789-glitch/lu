"use client";
import dynamic from "next/dynamic";
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore } from "react";
import { CalendarDays, Upload, ImagePlus, FileDown, FileInput, Check, LoaderCircle, AlertCircle, Headphones, PenLine, BookOpen, Sigma, X, Download } from "lucide-react";
import type { EditorHandle, Heading } from "./document-editor";
import type { Attachment, Lesson, LessonDetail, SaveState } from "@/lib/models";
import { api, downloadText, uploadFile } from "@/lib/client";
import { Modal } from "./ui";
import AudioPlayer from "./audio-player";
import EditorBoundary from "./editor-boundary";
import { AudioUploadQueue } from "@/lib/audio-upload-queue";

const Editor = dynamic(() => import("./document-editor"), { ssr: false, loading: () => <div className="editor-loading"><LoaderCircle className="spin" size={19} /> 正在打开笔记…</div> });
export type NoteHandle = { flush: () => Promise<boolean>; hasUnsaved:()=>boolean; getRevision:()=>number; importFiles: (files: File[], point?: { x: number; y: number }) => Promise<void> };
type Draft = { title: string; date: string; content: unknown[]; revision: number; time: string };
type Props = { lesson: LessonDetail; courseName: string; cloud?: boolean; theme: "light" | "dark"; audioUploads: AudioUploadQueue; onSaved: (lesson: Lesson) => void; onAttachments?:(id:string,files:Attachment[])=>void; onHeadings: (headings: Heading[]) => void; onState: (state: SaveState) => void; notify: (text: string) => void };

const NotePane = forwardRef<NoteHandle, Props>(function NotePane({ lesson, courseName, cloud=false, theme, audioUploads, onSaved, onAttachments, onHeadings, onState, notify }, ref) {
  const [title, setTitle] = useState(lesson.title); const [date, setDate] = useState(lesson.date); const [readOnly, setReadOnly] = useState(false); const [state, setState] = useState<SaveState>("saved"); const [saveError, setSaveError] = useState("");
  const [attachments, setAttachments] = useState(lesson.attachments); const [progress, setProgress] = useState<{ name: string; value: number } | null>(null); const uploading = useRef(0); const [lightbox, setLightbox] = useState("");
  const [draggingFiles, setDraggingFiles] = useState(false); const dragDepth = useRef(0);
  const removedAudio = useRef(new Set<string>());
  useEffect(()=>{setAttachments(lesson.attachments.filter(file=>!removedAudio.current.has(file.id)&&!audioUploads.removedReplacementIds().has(file.id)));},[lesson.attachments,audioUploads]);
  useEffect(()=>{onAttachments?.(lesson.id,attachments);},[attachments,lesson.id,onAttachments]);
  const completedUploads = useSyncExternalStore(audioUploads.subscribe, () => audioUploads.completionVersion(lesson.id), () => 0);
  useEffect(() => {
    if (!completedUploads) return; let active = true;
    void api<LessonDetail>(`lessons/${lesson.id}`).then(detail => {
      if (active) setAttachments(old => {
        const removed = new Set([...removedAudio.current, ...audioUploads.removedReplacementIds()]);
        const kept = old.filter(file => !removed.has(file.id)); const ids = new Set(kept.map(file => file.id));
        return [...kept, ...detail.attachments.filter(file => !ids.has(file.id) && !removed.has(file.id))].sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
      });
    }).catch(() => { if (active) notify("录音已上传，列表刷新失败；重新打开这节课即可查看。"); });
    return () => { active = false; };
  }, [completedUploads, lesson.id, notify]);
  const [importOpen, setImportOpen] = useState(false); const [markdown, setMarkdown] = useState(""); const [preview, setPreview] = useState<unknown[] | null>(null); const [importing, setImporting] = useState(false); const [recovery, setRecovery] = useState<Draft | null>(null);
  const editor = useRef<EditorHandle>(null); const audioInput = useRef<HTMLInputElement>(null); const imageInput = useRef<HTMLInputElement>(null); const markdownInput = useRef<HTMLInputElement>(null); const replacement = useRef<Attachment | null>(null);
  const pending = useRef({ title: lesson.title, date: lesson.date, content: lesson.content }); const revision = useRef(lesson.revision); const sequence = useRef(0); const savedSequence = useRef(0); const timer = useRef<ReturnType<typeof setTimeout> | null>(null); const running = useRef<Promise<boolean> | null>(null); const alive = useRef(true); const flushRef = useRef<() => Promise<boolean>>(async () => true);
  const draftKey = `classnote-draft-${lesson.id}`;
  const status = useCallback((value: SaveState) => { if (alive.current) setState(value); onState(value); }, [onState]);
  useEffect(() => { alive.current = true; try { const raw = localStorage.getItem(draftKey); if (raw) { const draft = JSON.parse(raw) as Draft; if (Array.isArray(draft.content) && typeof draft.title === "string" && typeof draft.date === "string") { if (JSON.stringify({ title: draft.title, date: draft.date, content: draft.content }) === JSON.stringify(pending.current)) localStorage.removeItem(draftKey); else setRecovery(draft); } } } catch { notify("无法读取浏览器草稿副本，已保存的笔记仍在知识库中"); }
    const beforeUnload = (event: BeforeUnloadEvent) => { if (sequence.current !== savedSequence.current || uploading.current > 0) { event.preventDefault(); event.returnValue = ""; } }; window.addEventListener("beforeunload", beforeUnload);
    return () => { alive.current = false; if (timer.current) clearTimeout(timer.current); window.removeEventListener("beforeunload", beforeUnload); };
  }, []);
  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current) clearTimeout(timer.current);
    if (uploading.current > 0) { notify("文件仍在上传，请等上传完成后再切换课堂"); return false; }
    if (running.current) { const ok = await running.current; return ok && sequence.current !== savedSequence.current ? flushRef.current() : ok; }
    if (sequence.current === savedSequence.current) return true;
    if (!pending.current.title.trim() || !pending.current.date) { setSaveError("请填写课堂标题和有效日期"); status("error"); return false; }
    const snapshot = structuredClone(pending.current); const target = sequence.current; status("saving");
    running.current = api<Lesson>(`lessons/${lesson.id}`, "PATCH", { ...snapshot, revision: revision.current }).then(saved => {
      revision.current = saved.revision; savedSequence.current = target; onSaved(saved); setSaveError("");
      if (sequence.current === target) { try { localStorage.removeItem(draftKey); } catch {} status("saved"); } else status("dirty"); return true;
    }).catch(error => { setSaveError((error as Error).message); status("error"); return false; }).finally(() => { running.current = null; });
    const ok = await running.current; return ok && sequence.current !== savedSequence.current ? flushRef.current() : ok;
  }, [lesson.id, status, onSaved]);
  flushRef.current = flush;
  useImperativeHandle(ref, () => ({ flush, hasUnsaved:()=>sequence.current!==savedSequence.current||!!running.current||uploading.current>0||!!recovery, getRevision:()=>revision.current, importFiles }));
  const change = useCallback((patch: Partial<typeof pending.current>) => {
    pending.current = { ...pending.current, ...patch }; sequence.current++; status("dirty");
    try { localStorage.setItem(draftKey, JSON.stringify({ ...pending.current, revision: revision.current, time: new Date().toISOString() })); } catch { notify("浏览器草稿副本无法写入，请保持页面打开，等待保存完成"); }
    if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => { void flushRef.current(); }, 750);
  },[draftKey,notify,status]);
  const upload = useCallback(async (file: File) => {
    uploading.current++; setProgress({ name: file.name, value: 0 });
    try { const result = await uploadFile(`lessons/${lesson.id}/attachments`, file, value => setProgress({ name: file.name, value })); setAttachments(old => [...old, result]); return result; }
    catch (error) { notify((error as Error).message); throw error; }
    finally { uploading.current--; if (!uploading.current) { setProgress(null); if (sequence.current !== savedSequence.current) { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => { void flushRef.current(); }, 100); } } }
  },[lesson.id,notify]);
  const uploadImage=useCallback(async(file:File)=>`/api/files/${(await upload(file)).id}`,[upload]);
  const editorChanged=useCallback((content:unknown[])=>change({content}),[change]);
  const enqueueAudio = (files: File[], replacementId?: string) => {
    for (const file of files) audioUploads.enqueue({ lessonId: lesson.id, lessonTitle: title, courseId: lesson.courseId }, file, files.length === 1 ? replacementId : undefined);
  };
  async function importFiles(files: File[], point?: { x: number; y: number }) {
    dragDepth.current = 0; setDraggingFiles(false);
    const audio = files.filter(file => /\.(mp3|m4a|wav|ogg|oga|opus|aac|flac|webm)$/i.test(file.name));
    const images = files.filter(file => /\.(png|jpe?g|webp|gif)$/i.test(file.name));
    const notes = files.filter(file => /\.(md|markdown|txt)$/i.test(file.name));
    if (audio.length + images.length + notes.length !== files.length) notify("支持常见录音、JPG/PNG/WEBP/GIF 图片和 Markdown/TXT 笔记，其他文件未导入。");
    enqueueAudio(audio);
    if ((images.length || notes.length) && readOnly) { notify("图片和笔记请先切换到编辑模式再拖入。"); return; }
    if (images.length) {
      if (!editor.current) notify("笔记正在加载，请稍后再拖入图片。");
      else try { await editor.current.insertImages(images, point); } catch (error) { notify((error as Error).message); }
    }
    if (notes.length) {
      if (notes.reduce((size,file)=>size+file.size,0) > 4*1024**2) { notify("本次导入的笔记请小于 4 MB"); return; }
      try { setMarkdown((await Promise.all(notes.map(file=>file.text()))).join("\n\n---\n\n")); setPreview(null); setImportOpen(true); }
      catch { notify("无法读取笔记文件，请重新拖入。"); }
    }
  }
  const importNotes = async () => {
    if (!preview?.length || !editor.current) return;
    // Keep the source text in a normal code block so unsupported Markdown is never silently discarded.
    editor.current.append([...preview, { type: "heading", props: { level: 3 }, content: "导入原文（备查）" }, { type: "codeBlock", props: { language: "markdown" }, content: markdown }]);
    setImportOpen(false); setPreview(null); setMarkdown(""); await flushRef.current();
  };
  const audioFiles = attachments.filter(file => file.kind === "audio");
  return <>
    <div className="note-utility"><div className="save-status" role="status" data-state={state}>{state === "saved" ? <Check size={14} /> : state === "error" ? <AlertCircle size={14} /> : state === "saving" ? <LoaderCircle size={14} className="spin" /> : <span className="pending-dot" />}{state === "saved" ? cloud ? "已保存到私人云端" : "已保存到本机" : state === "saving" ? "保存中…" : state === "dirty" ? "等待保存" : "保存失败"}</div><div className="mode-switch"><button className={!readOnly ? "active" : ""} onClick={() => setReadOnly(false)}><PenLine size={14} />编辑</button><button className={readOnly ? "active" : ""} onClick={() => setReadOnly(true)}><BookOpen size={14} />阅读</button></div></div>
    <article className={`note-page ${readOnly ? "reading" : ""} ${draggingFiles ? "file-drag-over" : ""}`} onDragEnter={event => { if(event.dataTransfer.types.includes("Files")){event.preventDefault();dragDepth.current++;setDraggingFiles(true);} }} onDragLeave={() => {dragDepth.current=Math.max(0,dragDepth.current-1);if(!dragDepth.current)setDraggingFiles(false);}}>
      {draggingFiles && <div className="file-drop-hint" role="status">松开以导入录音或图片到「{title}」</div>}
      {recovery && <div className="recovery-banner"><AlertCircle size={18} /><div><strong>发现未保存的草稿</strong><span>恢复前不会覆盖数据库中的版本。</span></div><button className="text-button" onClick={() => { if (!editor.current) return; setTitle(recovery.title); setDate(recovery.date); editor.current.replace(recovery.content); change({ title: recovery.title, date: recovery.date, content: recovery.content }); setRecovery(null); }}>恢复草稿</button><button className="icon-button" aria-label="导出恢复草稿" onClick={() => downloadText(`${recovery.title}-草稿.json`, JSON.stringify(recovery, null, 2), "application/json")}><Download size={15} /></button><button className="icon-button" aria-label="暂不恢复" onClick={() => setRecovery(null)}><X size={15} /></button></div>}
      {saveError && <div className="error-banner" role="alert"><AlertCircle size={18} /><div>{saveError}<small>未保存内容保留在当前页面和浏览器草稿副本中。</small></div><button className="text-button" onClick={() => void flushRef.current()}>重试</button><button className="text-button" onClick={() => downloadText(`${title}-草稿.json`, JSON.stringify(pending.current, null, 2), "application/json")}>导出草稿</button></div>}
      <div className="course-label"><span />{courseName}</div>
      <input className="note-title" aria-label="课堂标题" placeholder="未命名课堂" value={title} readOnly={readOnly} maxLength={200} onChange={event => { setTitle(event.target.value); change({ title: event.target.value }); }} />
      <div className="note-meta"><CalendarDays size={15} /><input aria-label="上课日期" type="date" value={date} disabled={readOnly} onChange={event => { setDate(event.target.value); change({ date: event.target.value }); }} /><span className="meta-separator" /><span>{readOnly ? "阅读模式" : "记录课堂，也记录理解"}</span></div>
      <div className="document-tools"><button className="tool-button" onClick={() => { replacement.current = null; audioInput.current?.click(); }}><Upload size={15} />上传录音</button>{!readOnly && <><button className="tool-button" onClick={() => imageInput.current?.click()}><ImagePlus size={15} />插入图片</button><button className="tool-button" onClick={() => { setPreview(null); setImportOpen(true); }}><FileInput size={15} />导入笔记</button><button className="tool-button formula-tool" onClick={() => editor.current?.insertFormula()}><Sigma size={15} />公式</button></>}<button className="tool-button export-tool" onClick={async () => { try { const text = await editor.current?.markdown(); if (text !== undefined) downloadText(`${title}.md`, `# ${title}\n\n${date} · ${courseName}\n\n${text}`); } catch { notify("导出失败，请重试"); } }}><FileDown size={15} /><span>导出</span></button></div>
      {progress && <div className="upload-progress" role="status"><LoaderCircle size={15} className="spin" /><span>{progress.name}</span><progress max="100" value={progress.value} /><b>{progress.value === 99 ? "正在保存文件…" : `${progress.value}%`}</b></div>}
      {audioFiles.length ? <AudioPlayer files={audioFiles} onChange={files => { const kept=new Set(files.map(file=>file.id));for(const file of attachments)if(file.kind==="audio"&&!kept.has(file.id))removedAudio.current.add(file.id);setAttachments(old => [...old.filter(file => file.kind !== "audio"), ...files]); }} onReplace={file => { replacement.current = file; audioInput.current?.click(); }} notify={notify} /> : <button className="audio-empty" onClick={() => { replacement.current = null; audioInput.current?.click(); }}><span className="audio-empty-icon"><Headphones size={22} /></span><span><strong>把这一节课，留下来</strong><small>添加课堂录音，随时回听与复习</small></span><span className="audio-upload-label"><Upload size={14} />添加录音</span></button>}
      <div className="note-body"><EditorBoundary content={pending.current.content} title={title}><Editor ref={editor} initialContent={lesson.content} readOnly={readOnly} theme={theme} upload={uploadImage} onChange={editorChanged} onHeadings={onHeadings} onImageOpen={setLightbox} /></EditorBoundary></div>
      {!readOnly && <div className="document-hint">输入 / 插入内容 <span>·</span> 拖动左侧手柄调整段落与图片顺序 <span>·</span> 双击图片放大</div>}
      <div className="document-end"><span />ClassNote<span /></div>
    </article>
    <input ref={audioInput} type="file" className="sr-only" accept=".mp3,.m4a,.wav,.ogg,.oga,.opus,.aac,.flac,.webm" multiple onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ""; const replacing = replacement.current; replacement.current = null; enqueueAudio(files, replacing?.id); }} />
    <input ref={imageInput} type="file" className="sr-only" accept="image/png,image/jpeg,image/webp,image/gif" onChange={async event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) try { await editor.current?.insertImage(file); } catch {} }} />
    <Modal open={importOpen} onOpenChange={value => { if (!importing) setImportOpen(value); }} title="导入课堂笔记" description="粘贴 ChatGPT 整理的 Markdown，或选择 .md 文件。预览确认后追加到正文，不覆盖已有内容。" wide>
      <div className="import-tabs"><button className={!preview ? "active" : ""} onClick={() => setPreview(null)}>Markdown 原文</button><button className={preview ? "active" : ""} disabled={!markdown.trim() || importing} onClick={async () => { setImporting(true); try { setPreview(await editor.current?.parseMarkdown(markdown) || []); } catch { notify("转换失败，原文已保留，请检查内容"); } finally { setImporting(false); } }}>{importing ? "正在转换…" : "预览转换结果"}</button><button className="text-button" onClick={() => markdownInput.current?.click()}>选择 .md 文件</button></div>
      {preview ? <div className="import-preview"><Editor key={JSON.stringify(preview).slice(0, 100)} initialContent={preview} readOnly theme={theme} /></div> : <textarea className="markdown-input" aria-label="Markdown原文" placeholder={"# 课堂重点\n\n在这里粘贴笔记…"} value={markdown} onChange={event => setMarkdown(event.target.value)} />}
      <p className="import-notice">会同时保留一份导入原文。独立的 $$ LaTeX $$ 公式可渲染；其他复杂格式请对照预览检查。外部图片保留为链接。</p><div className="dialog-actions"><button className="secondary-button" onClick={() => setImportOpen(false)}>取消</button><button className="primary-button" disabled={!preview?.length} onClick={() => void importNotes()}>追加到当前笔记</button></div>
    </Modal>
    <input ref={markdownInput} className="sr-only" type="file" accept=".md,.markdown,text/markdown,text/plain" onChange={async event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) { if (file.size > 4 * 1024 ** 2) { notify("Markdown 文件请小于 4 MB"); return; } setMarkdown(await file.text()); setPreview(null); } }} />
    <Modal open={!!lightbox} onOpenChange={() => setLightbox("")} title="课堂图片" wide><div className="lightbox">{lightbox && <img src={lightbox} alt="课堂笔记图片放大查看" />}</div></Modal>
  </>;
});
export default memo(NotePane);
