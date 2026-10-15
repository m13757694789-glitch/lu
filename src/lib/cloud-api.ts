import { z } from "zod";
import { AppError, idSchema } from "./validation.ts";
import { readJson } from "./api-router.ts";
import { cloudClient, cloudConfig, requireOwner } from "./cloud-auth.ts";
import { CloudStore, checked } from "./cloud-store.ts";
import { beginUpload, signPart, completePart, completeUpload, removeCloudFile, serveCloudFile } from "./cloud-files.ts";
import type { Attachment } from "./models.ts";

const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'no-referrer'};
export async function handleCloud(request:Request) {
  try {
    const [resource,id,action]=new URL(request.url).pathname.split('/').filter(Boolean).slice(1);
    const method=request.method; const client=await cloudClient();
    if(resource==='session'&&method==='GET') {
      const {data,error}=await client.auth.getUser();
      if(error&&error.name!=='AuthSessionMissingError'&&!("status" in error&&[400,401,403].includes(Number(error.status)))) throw new AppError("登录服务暂时无法响应，请稍后重试",503);
      const user=data.user;
      return Response.json({mode:'cloud',authenticated:!!user&&!!user.email_confirmed_at&&user.email?.toLowerCase()===cloudConfig().owner,email:user?.email||null},{headers});
    }
    if(resource==='login'&&method==='POST') {
      const input=z.object({email:z.string().email().max(320),password:z.string().min(1).max(1024)}).parse(await readJson(request,4096));
      if(input.email.toLowerCase()!==cloudConfig().owner) throw new AppError("邮箱或密码不正确",401);
      const {error}=await client.auth.signInWithPassword(input);
      if(error) throw new AppError(error.status===429?"尝试次数过多，请稍后再登录":"邮箱或密码不正确，请重试",error.status===429?429:401);
      const user=await requireOwner(client); return Response.json({ok:true,email:user.email},{headers});
    }
    if(resource==='logout'&&method==='POST') {
      const {error}=await client.auth.signOut({scope:'local'}); if(error) throw new AppError("退出登录失败，请重试",503);
      return Response.json({ok:true},{headers});
    }
    const owner=await requireOwner(client); const store=new CloudStore(client,owner.id);
    if(id) idSchema.parse(id);
    let result:unknown;
    if(method==='GET'&&resource==='library'&&!id) result=await store.library();
    else if(method==='GET'&&resource==='search'&&!id) result=await store.search((new URL(request.url).searchParams.get('q')||'').slice(0,200));
    else if(method==='GET'&&resource==='health'&&!id) result={app:'ClassNote',version:'1.1.0',storage:'supabase-private'};
    else if(method==='GET'&&resource==='usage'&&!id) {
      const rows=await checked<{size:number}[]>(client.from('cn_attachments').select('size'));
      result={used:rows.reduce((sum,row)=>sum+row.size,0),limit:1024**3};
    }
    else if(method==='GET'&&resource==='lessons'&&id) result=await store.detail(id,true);
    else if((method==='GET'||method==='HEAD')&&resource==='files'&&id) return await serveCloudFile(request,store,id);
    else if(method==='POST'&&resource==='courses'&&!id) result=await store.createCourse(await readJson(request));
    else if(method==='POST'&&resource==='lessons'&&!id) result=await store.createLesson(await readJson(request));
    else if(method==='POST'&&resource==='lessons'&&id&&action==='attachments') result=await beginUpload(store,id,await readJson(request,4096));
    else if(method==='POST'&&resource==='uploads'&&id&&action==='sign') result=await signPart(store,id,await readJson(request,4096));
    else if(method==='POST'&&resource==='uploads'&&id&&action==='part') result=await completePart(store,id,await readJson(request,4096));
    else if(method==='POST'&&resource==='uploads'&&id&&action==='complete') result=await completeUpload(store,id,await readJson(request,4096));
    else if(method==='DELETE'&&resource==='uploads'&&id) {await removeCloudFile(store,id,true);result={ok:true};}
    else if(method==='PATCH'&&resource==='courses'&&id) result=await store.updateCourse(id,await readJson(request));
    else if(method==='PATCH'&&resource==='lessons'&&id) result=await store.updateLesson(id,await readJson(request));
    else if(method==='PATCH'&&resource==='files'&&id) result=await store.updateAttachment(id,await readJson(request));
    else if(method==='PATCH'&&resource==='settings'&&!id) {await store.settings(await readJson(request));result={ok:true};}
    else if(method==='DELETE'&&resource==='files'&&id) {await removeCloudFile(store,id);result={ok:true};}
    else if(method==='DELETE'&&(resource==='courses'||resource==='lessons')&&id) {
      const lessonIds=resource==='lessons'?[id]:(await checked<{id:string}[]>(client.from('cn_lessons').select('id').eq('courseId',id))).map(row=>row.id);
      if(resource==='courses') await store.course(id); else await store.lesson(id);
      for(const lessonId of lessonIds) {
        const files=await checked<{id:string}[]>(client.from('cn_attachments').select('id').eq('lessonId',lessonId));
        for(const file of files) await removeCloudFile(store,file.id,true,true);
      }
      await checked(client.from(resource==='courses'?'cn_courses':'cn_lessons').delete().eq('id',id)); result={ok:true};
    }
    else if(method==='GET'&&resource==='backup-index'&&!id) {
      const files:Attachment[]=[];
      for(let offset=0;;offset+=1000) {const rows=await checked<Attachment[]>(client.from('cn_attachments').select('id,lessonId,name,kind,mime,size,filename,sha256,position,createdAt').eq('ready',true).order('id').range(offset,offset+999));files.push(...rows);if(rows.length<1000) break;}
      result={...await store.library(),attachments:files};
    }
    else throw new AppError("接口不存在",404);
    return Response.json(result,{status:method==='POST'?201:200,headers});
  } catch(error) {
    const status=error instanceof AppError?error.status:error instanceof z.ZodError?400:500;
    return Response.json({error:error instanceof AppError?error.message:error instanceof z.ZodError?"输入格式不正确，请检查名称、日期或笔记内容":"云端服务暂时无法响应，请稍后重试"},{status,headers});
  }
}
