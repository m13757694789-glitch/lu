import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { api, downloadText } from "./client";
import type { Attachment } from "./models";

function putPart(url:string,blob:Blob,progress:(loaded:number)=>void) {
  return new Promise<void>((resolve,reject)=>{
    const xhr=new XMLHttpRequest(); xhr.open('PUT',url);xhr.setRequestHeader('Content-Type',blob.type||'application/octet-stream');xhr.setRequestHeader('cache-control','max-age=0');xhr.setRequestHeader('x-upsert','false');
    xhr.upload.onprogress=event=>progress(event.loaded);xhr.onerror=()=>reject(new Error('上传中断，请检查网络连接'));xhr.onabort=()=>reject(new Error('上传已取消'));
    xhr.onload=()=>xhr.status>=200&&xhr.status<300?resolve():reject(new Error(`私人存储上传失败（${xhr.status}），请重试`));xhr.send(blob);
  });
}
export async function uploadCloud<T>(path:string,file:File,progress:(value:number)=>void):Promise<T> {
  if(path==='restore') return (await import('./cloud-backup-client')).restoreCloud(file,progress) as Promise<T>;
  const upload=await api<{id:string;partSize:number;parts:number;mime:string}>(path,'POST',{name:file.name,size:file.size});
  const fullHash=sha256.create(); let completed=false;
  try {
    for(let index=0;index<upload.parts;index++) {
      const start=index*upload.partSize; const blob=file.slice(start,Math.min(file.size,start+upload.partSize),upload.mime);
      const hash=sha256.create(); const reader=blob.stream().getReader(); let sinceYield=0;
      while(true) {const part=await reader.read();if(part.done) break;hash.update(part.value);fullHash.update(part.value);sinceYield+=part.value.length;if(sinceYield>=4*1024**2){sinceYield=0;await new Promise(resolve=>setTimeout(resolve,0));}}
      const expected=bytesToHex(hash.digest());
      const signed=await api<{url:string}>(`uploads/${upload.id}/sign`,'POST',{index});
      try {await putPart(signed.url,blob,loaded=>progress(Math.min(98,Math.round((start+Math.min(loaded,blob.size))/file.size*98))));}
      catch(error) { // A lost acknowledgement can still mean that the object arrived.
        const verified=await api<{sha256:string}>(`uploads/${upload.id}/part`,'POST',{index}).catch(()=>null);
        if(verified?.sha256!==expected) throw error;
      }
      const verified=await api<{sha256:string}>(`uploads/${upload.id}/part`,'POST',{index});
      if(verified.sha256!==expected) throw new Error('上传校验失败，请重新上传原文件');
    }
    progress(99);const row=await api<T>(`uploads/${upload.id}/complete`,'POST',{sha256:bytesToHex(fullHash.digest())});completed=true;progress(100);return row;
  } finally {if(!completed) await api(`uploads/${upload.id}`,'DELETE').catch(()=>{});}
}

export async function* readCloudFile(file:Attachment) {
  let offset=0;const hash=sha256.create();
  while(offset<file.size) {
    const response=await fetch(`/api/files/${file.id}?raw`,{headers:{Range:`bytes=${offset}-${Math.min(file.size-1,offset+4*1024**2-1)}`},cache:'no-store'});
    if(response.status!==206) {const data=await response.json().catch(()=>null);throw new Error(data?.error||'附件读取失败，请稍后重试');}
    const range=response.headers.get('content-range');const match=range&&/^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
    const chunk=new Uint8Array(await response.arrayBuffer());
    if(!match||Number(match[1])!==offset||Number(match[3])!==file.size||chunk.length!==Number(match[2])-offset+1||!chunk.length) throw new Error('附件传输不完整，请重试');
    hash.update(chunk);offset+=chunk.length;yield chunk;
  }
  if(bytesToHex(hash.digest())!==file.sha256) throw new Error('附件完整性校验失败，请保留原文件并联系网站所有者');
}
type Writer = {write:(data:Uint8Array)=>Promise<void>;close:()=>Promise<void>;abort:()=>Promise<void>};
type SaveWindow = Window & {showSaveFilePicker?:(options:{suggestedName:string})=>Promise<{createWritable:()=>Promise<Writer>}>};
export async function fileSink(name:string,limit=128*1024**2):Promise<Writer> {
  const picker=(window as SaveWindow).showSaveFilePicker;
  if(picker) return (await picker.call(window,{suggestedName:name})).createWritable();
  const chunks:Uint8Array<ArrayBuffer>[]=[];let size=0;
  return {
    async write(chunk){size+=chunk.length;if(size>limit) throw new Error('大文件下载请使用支持“选择保存位置”的 Chrome、Edge 或 Tabbit 浏览器');chunks.push(Uint8Array.from(chunk));},
    async close(){const url=URL.createObjectURL(new Blob(chunks));const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);},
    async abort(){chunks.length=0;},
  };
}
export async function downloadCloudFile(file:Attachment) {
  const writer=await fileSink(file.name);
  try {for await(const chunk of readCloudFile(file)) await writer.write(chunk);await writer.close();}
  catch(error){await writer.abort().catch(()=>{});throw error;}
}
