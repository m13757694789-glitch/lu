"use client";
import { useCallback, useEffect, useState } from "react";
import { BookOpen, LockKeyhole, LoaderCircle, ShieldCheck } from "lucide-react";
import { api, setClientMode } from "@/lib/client";
import WorkspaceSession from "./workspace-session";
import { recordUIError } from "@/lib/ui-recovery";

type Session = { mode:"local"|"cloud"; authenticated:boolean; email?:string };
export default function AuthGate() {
  const [session,setSession]=useState<Session|null>(null); const [error,setError]=useState('');
  const [reauth,setReauth]=useState(false);
  const [email,setEmail]=useState(''); const [password,setPassword]=useState(''); const [busy,setBusy]=useState(false);
  const load=useCallback(async()=>{
    setError('');
    try {const state=await api<Session>('session');setClientMode(state.mode);setSession(state);if(state.authenticated)setReauth(false);}
    catch(error){setError((error as Error).message);}
  },[]);
  useEffect(()=>{void load();},[load]);
  useEffect(()=>{
    const failed=(event:ErrorEvent)=>recordUIError(event.error || new Error(event.message));
    const rejected=(event:PromiseRejectionEvent)=>recordUIError(event.reason);
    window.addEventListener('error',failed);window.addEventListener('unhandledrejection',rejected);
    return()=>{window.removeEventListener('error',failed);window.removeEventListener('unhandledrejection',rejected);};
  },[]);
  useEffect(()=>{const expired=()=>{setReauth(true);setError('登录已过期，请重新登录。当前笔记与草稿会保留。');};window.addEventListener('classnote-auth-expired',expired);return()=>window.removeEventListener('classnote-auth-expired',expired);},[]);
  return <>{session?.authenticated&&<WorkspaceSession cloud={session.mode==='cloud'} email={session.email} onLogout={()=>{setPassword('');setSession(null);setReauth(false);void load();}} />}
  {(!session?.authenticated||reauth)&&<main className={`auth-page ${reauth?'auth-overlay':''}`}><div className="auth-sheet">
    <div className="auth-brand"><BookOpen size={25}/><span>ClassNote<small>课堂知识库</small></span></div>
    <div className="auth-lock"><LockKeyhole size={27} strokeWidth={1.5}/></div>
    <h1>回到你的学习空间</h1><p>登录后，继续整理课堂里的每一次理解。</p>
    {!session&&!error?<div className="auth-loading" role="status"><LoaderCircle className="spin" size={18}/>正在连接私人知识库…</div>:<>
      {session&&<form onSubmit={async event=>{
        event.preventDefault();setBusy(true);setError('');
        try {await api('login','POST',{email,password});setPassword('');await load();}
        catch(error){setError((error as Error).message);}finally{setBusy(false);}
      }}><label className="field">邮箱<input type="email" autoComplete="username" value={email} onChange={event=>setEmail(event.target.value)} required disabled={busy}/></label>
      <label className="field">密码<input type="password" autoComplete="current-password" value={password} onChange={event=>setPassword(event.target.value)} required disabled={busy}/></label>
      <button className="primary-button auth-submit" disabled={busy}>{busy?<><LoaderCircle size={16} className="spin"/>正在登录…</>:'打开我的知识库'}</button></form>}
      {error&&<p className="auth-error" role="alert">{error}</p>}
      {!session&&<button className="secondary-button" onClick={()=>void load()}>重新连接</button>}
    </>}
    <div className="auth-privacy"><ShieldCheck size={16}/><span>私人账号访问，录音与笔记均受保护。</span></div>
  </div></main>}</>;
}
