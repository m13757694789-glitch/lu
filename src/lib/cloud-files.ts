import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "./validation.ts";
import { CloudStore, checked, type CloudAttachment } from "./cloud-store.ts";
import { cloudConfig } from "./cloud-auth.ts";
import { byteRange } from "./ranges.ts";
import { attachmentStorage, privateObjectPath, signR2Upload, r2ObjectUrl, removeR2Objects } from './r2-storage.ts';
import { uploadMetadata } from './upload-metadata.ts';

const types: Record<string,["audio"|"image",string]>={
  mp3:['audio','audio/mpeg'],m4a:['audio','audio/mp4'],wav:['audio','audio/wav'],ogg:['audio','audio/ogg'],oga:['audio','audio/ogg'],opus:['audio','audio/ogg'],aac:['audio','audio/aac'],flac:['audio','audio/flac'],webm:['audio','audio/webm'],
  jpg:['image','image/jpeg'],jpeg:['image','image/jpeg'],png:['image','image/png'],webp:['image','image/webp'],gif:['image','image/gif'],
};
export async function beginUpload(store:CloudStore,lessonId:string,input:unknown) {
  const data=uploadMetadata(input);
  await store.lesson(lessonId);
  const extension=data.name.split('.').at(-1)?.toLowerCase()||''; const type=types[extension];
  if(!type) throw new AppError("不支持这个文件格式，请上传常见音频或 JPG、PNG、WEBP、GIF 图片");
  if(type[0]==='image'&&data.size>50*1024**2) throw new AppError("图片须小于 50 MB");
  const stale=await checked<{id:string}[]>(store.client.from('cn_attachments').select('id').eq('ready',false).lt('createdAt',new Date(Date.now()-24*3600*1000).toISOString()));
  for(const file of stale) await removeCloudFile(store,file.id,true);
  const id=randomUUID(); const partSize=type[0]==='image'?50*1024**2:32*1024**2;
  const provider=attachmentStorage();
  const row=await checked<CloudAttachment>(store.client.rpc(provider==='r2'?'cn_begin_r2_upload':'cn_begin_upload',{file_id:id,lesson_id:lessonId,file_name:data.name,file_kind:type[0],file_mime:type[1],file_size:data.size,stored_name:`${id}.${extension}`,chunk_size:partSize}).single());
  return {id:row.id,partSize:row.part_size,parts:Math.ceil(row.size/row.part_size),mime:row.mime};
}
function indexOf(row:CloudAttachment,input:unknown) {
  const {index}=z.object({index:z.number().int().nonnegative()}).parse(input);
  if(index>=Math.ceil(row.size/row.part_size)) throw new AppError("上传分段编号无效"); return index;
}
export async function signPart(store:CloudStore,id:string,input:unknown) {
  const row=await store.attachment(id,true); if(row.ready) throw new AppError("附件已完成上传",409);
  const index=indexOf(row,input); const path=privateObjectPath(store.owner,id,index);
  if(row.storage_provider==='r2') return signR2Upload(store.owner,id,index,Math.min(row.part_size,row.size-index*row.part_size),row.mime);
  const {data,error}=await store.client.storage.from(cloudConfig().bucket).createSignedUploadUrl(path);
  if(error||!data) throw new AppError("暂时无法准备私有上传，请稍后重试",503);
  return {url:data.signedUrl,path,index,headers:{'cache-control':'max-age=0','x-upsert':'false'}};
}
function imageValid(mime:string,head:Buffer) {
  return mime==='image/png'?head.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):mime==='image/jpeg'?head[0]===255&&head[1]===216&&head[2]===255:mime==='image/webp'?head.toString('ascii',0,4)==='RIFF'&&head.toString('ascii',8,12)==='WEBP':/^GIF8[79]a/.test(head.toString('ascii'));
}
async function objectUrl(store:CloudStore,row:CloudAttachment,index:number,download?:string) {
  const path=privateObjectPath(store.owner,row.id,index);
  if(row.storage_provider==='r2') return r2ObjectUrl(store.owner,row.id,index,download);
  const {data,error}=await store.client.storage.from(cloudConfig().bucket).createSignedUrl(path,60,download?{download}:undefined);
  if(error||!data) throw new AppError("无法读取私人附件，请稍后重试",503);
  if(new URL(data.signedUrl).origin!==new URL(cloudConfig().url).origin) throw new AppError("存储地址无效",503);
  return data.signedUrl;
}
export async function completePart(store:CloudStore,id:string,input:unknown) {
  const row=await store.attachment(id,true); const index=indexOf(row,input);
  const expectedHash=z.object({sha256:z.string().regex(/^[\da-f]{64}$/).optional()}).parse(input).sha256;
  // Objects cannot be overwritten by storage policy. Reusing verified metadata makes lost responses cheap to retry.
  const saved=await checked<{sha256:string}|null>(store.client.from('cn_file_parts').select('sha256').eq('attachment_id',id).eq('part_no',index).maybeSingle());
  if(saved) {if(expectedHash&&saved.sha256!==expectedHash) throw new AppError("上传校验失败，请重新上传原文件",409);return {ok:true,sha256:saved.sha256};}
  if(row.ready) throw new AppError("附件分段不存在",409);
  const path=privateObjectPath(store.owner,id,index);
  const expected=Math.min(row.part_size,row.size-index*row.part_size);
  const response=await fetch(await objectUrl(store,row,index),{cache:'no-store',signal:AbortSignal.timeout(110000)});
  if(!response.ok||!response.body) throw new AppError("分段上传尚未完成，请重试",409);
  const reader=response.body.getReader(); const hash=createHash('sha256'); let size=0; let head=Buffer.alloc(0);
  try {
    while(true) { const part=await reader.read(); if(part.done) break; size+=part.value.length; if(size>expected) throw new AppError("文件分段大小不正确");
      if(head.length<16) head=Buffer.concat([head,Buffer.from(part.value.subarray(0,16-head.length))]); hash.update(part.value);
    }
  } finally { await reader.cancel().catch(()=>{}); }
  if(size!==expected) throw new AppError("文件传输不完整，请重试");
  if(row.kind==='image'&&!imageValid(row.mime,head)) throw new AppError("文件内容与图片格式不符");
  const digest=hash.digest('hex');
  if(expectedHash&&digest!==expectedHash) throw new AppError("上传校验失败，请重新上传原文件",409);
  await checked(store.client.from('cn_file_parts').upsert({attachment_id:id,part_no:index,path,size,sha256:digest},{onConflict:'attachment_id,part_no'}));
  return {ok:true,sha256:digest};
}
export async function completeUpload(store:CloudStore,id:string,input:unknown) {
  const {sha256}=z.object({sha256:z.string().regex(/^[\da-f]{64}$/)}).parse(input);
  return checked<CloudAttachment>(store.client.rpc('cn_finish_upload',{file_id:id,file_hash:sha256}).single());
}
export async function removeCloudFile(store:CloudStore,id:string,pending=false,removingParent=false) {
  const row=await store.attachment(id,pending);
  if(!removingParent&&row.kind==='image'&&row.ready&&JSON.stringify((await store.lesson(row.lessonId)).content).includes(`/api/files/${id}`)) throw new AppError("图片仍在正文中，请先删除对应图片块");
  if(row.storage_provider==='r2') await removeR2Objects(store.owner,id);
  else {
  const prefix=privateObjectPath(store.owner,id,0).replace(/\/0$/,'');
  const {data,error}=await store.client.storage.from(cloudConfig().bucket).list(prefix,{limit:1000});
  if(error) throw new AppError("无法清理云端附件，请稍后重试",503);
  if(data?.length) {
    const removed=await store.client.storage.from(cloudConfig().bucket).remove(data.map(item=>`${prefix}/${item.name}`));
    if(removed.error) throw new AppError("附件未能删除，请稍后重试",503);
  }
  }
  await checked(store.client.from('cn_attachments').delete().eq('id',id));
}
export async function serveCloudFile(request:Request,store:CloudStore,id:string) {
  const row=await store.attachment(id); const parts=await store.parts(id);
  if(parts.length!==Math.ceil(row.size/row.part_size)||parts.some((part,index)=>part.part_no!==index||part.path!==privateObjectPath(store.owner,id,index))) throw new AppError("附件不完整，请从备份恢复",503);
  const headers=new Headers({'Content-Type':row.mime,'Accept-Ranges':'bytes','X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'});
  headers.set('Content-Disposition',`inline; filename*=UTF-8''${encodeURIComponent(row.name)}`);
  if(request.method==='HEAD'&&!request.headers.has('range')) {headers.set('Content-Length',String(row.size));return new Response(null,{headers});}
  const url=new URL(request.url);
  if((row.kind==='image'&&!url.searchParams.has('raw'))||(url.searchParams.has('download')&&parts.length===1)) {
    const signed=await objectUrl(store,row,0,url.searchParams.has('download')?row.name:undefined);
    return new Response(null,{status:307,headers:{Location:signed,'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer'}});
  }
  const range=byteRange(request.headers.get('range'),row.size,4*1024**2);
  if(!range) return new Response(null,{status:416,headers:{'Content-Range':`bytes */${row.size}`,'Cache-Control':'private, no-store'}});
  const {start,end}=range; headers.set('Content-Range',`bytes ${start}-${end}/${row.size}`); headers.set('Content-Length',String(end-start+1));
  if(request.method==='HEAD') return new Response(null,{status:206,headers});
  let offset=start; let active:ReadableStreamDefaultReader<Uint8Array>|undefined;
  const body=new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while(offset<=end) {
          if(!active) {
            const part=parts[Math.floor(offset/row.part_size)]; const localStart=offset-part.part_no*row.part_size; const localEnd=Math.min(part.size-1,end-part.part_no*row.part_size);
            const response=await fetch(await objectUrl(store,row,part.part_no),{headers:{Range:`bytes=${localStart}-${localEnd}`},cache:'no-store',signal:request.signal});
            if(response.status!==206||!response.body||response.headers.get('content-range')!==`bytes ${localStart}-${localEnd}/${part.size}`) throw new Error('Private storage range unavailable'); active=response.body.getReader();
          }
          const chunk=await active.read();
          if(chunk.done) {active=undefined;continue;}
          offset+=chunk.value.length; if(offset>end+1) throw new Error('Invalid storage response length'); controller.enqueue(chunk.value);return;
        }
        await active?.cancel().catch(()=>{});controller.close();
      } catch(error) {await active?.cancel().catch(()=>{});controller.error(error);}
    },
    async cancel(){await active?.cancel().catch(()=>{});},
  });
  return new Response(body,{status:206,headers});
}
