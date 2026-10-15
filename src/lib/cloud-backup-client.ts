import { Zip, ZipPassThrough, strToU8, strFromU8, unzip } from "fflate";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { api } from "./client";
import { fileSink, readCloudFile, uploadCloud } from "./cloud-client";
import { manifestSchema } from "./backup-schema";
import { mapAttachmentUrls, type Attachment, type Course, type Lesson, type LessonDetail, type Library } from "./models";

export async function exportCloudBackup(progress:(message:string)=>void) {
  const writer=await fileSink(`classnote-backup-${new Date().toISOString().slice(0,10)}.zip`,256*1024**2);
  let writing=Promise.resolve();let zipError:Error|null=null;
  const zip=new Zip((error,data)=>{if(error) zipError=error;else writing=writing.then(()=>writer.write(data));});
  try {
    const index=await api<Library&{attachments:Attachment[]}>('backup-index');
    const lessons:Lesson[]=[];
    for(const lesson of index.lessons) {progress(`正在读取笔记 ${lessons.length+1}/${index.lessons.length}`);const detail=await api<LessonDetail>(`lessons/${lesson.id}`);const {attachments:_,...row}=detail;lessons.push(row);}
    const manifest={format:'classnote',version:1,exportedAt:new Date().toISOString(),courses:index.courses,lessons,settings:index.settings,attachments:index.attachments};
    manifestSchema.parse(manifest);
    const metadata=new ZipPassThrough('manifest.json');zip.add(metadata);metadata.push(strToU8(JSON.stringify(manifest)),true);await writing;
    for(let i=0;i<index.attachments.length;i++) {
      const file=index.attachments[i];progress(`正在备份附件 ${i+1}/${index.attachments.length}：${file.name}`);
      const entry=new ZipPassThrough(`files/${file.filename}`);zip.add(entry);
      for await(const chunk of readCloudFile(file)){entry.push(chunk,false);await writing;if(zipError) throw zipError;}
      entry.push(new Uint8Array(),true);await writing;
    }
    zip.end();await writing;if(zipError) throw zipError;await writer.close();progress('完整备份已保存');
  } catch(error){zip.terminate();await writer.abort().catch(()=>{});throw error;}
}
export async function restoreCloud(file:File,progress:(value:number)=>void) {
  const maximum=256*1024**2;
  if(file.size>maximum) throw new Error('线上恢复暂支持 256 MB 以内的备份；更大的备份可先在本机版恢复后分批上传');
  let uncompressed=0;const names=new Set<string>();
  const input=new Uint8Array(await file.arrayBuffer());
  const archive=await new Promise<Record<string,Uint8Array>>((resolve,reject)=>unzip(input,{filter:entry=>{
    if(names.has(entry.name)||names.size>100001||entry.originalSize<0||!['manifest.json','files/'].includes(entry.name)&&!/^files\/[\da-f-]{36}\.[a-z0-9]{1,8}$/.test(entry.name)) throw new Error('备份包含重复或未知路径');
    names.add(entry.name);uncompressed+=entry.originalSize;if(uncompressed>maximum) throw new Error('解压后的备份超过线上恢复的 256 MB 限制');return true;
  }},(error,files)=>error?reject(error):resolve(files)));
  if(!archive['manifest.json']||archive['manifest.json'].length>32*1024**2) throw new Error('备份缺少清单或清单过大');
  const data=manifestSchema.parse(JSON.parse(strFromU8(archive['manifest.json'])));
  const courses=new Set(data.courses.map(row=>row.id));const lessons=new Set(data.lessons.map(row=>row.id));const files=new Set(data.attachments.map(row=>row.id));
  const allIds=[...data.courses,...data.lessons,...data.attachments].map(row=>row.id);
  if(new Set(allIds).size!==allIds.length||data.lessons.some(row=>!courses.has(row.courseId))||data.attachments.some(row=>!lessons.has(row.lessonId))) throw new Error('备份包含无效的数据关联或重复 ID');
  const expectedNames=new Set(['manifest.json','files/',...data.attachments.map(row=>`files/${row.filename}`)]);
  if(Object.keys(archive).some(name=>!expectedNames.has(name))) throw new Error('备份包含未知附件');
  for(const attachment of data.attachments) {
    const content=archive[`files/${attachment.filename}`];if(!content||content.length!==attachment.size) throw new Error('备份附件缺失或大小不符');
    const hash=sha256.create();for(let offset=0;offset<content.length;offset+=4*1024**2){hash.update(content.subarray(offset,offset+4*1024**2));await new Promise(resolve=>setTimeout(resolve,0));}
    if(bytesToHex(hash.digest())!==attachment.sha256) throw new Error('附件校验失败，备份可能已损坏');
  }
  for(const lesson of data.lessons) mapAttachmentUrls(lesson.content,id=>{if(!files.has(id)||data.attachments.find(row=>row.id===id)?.lessonId!==lesson.id) throw new Error('正文引用了缺失的图片');return id;});
  const created:string[]=[];const courseIds=new Map<string,string>();const lessonIds=new Map<string,string>();const fileIds=new Map<string,string>();
  try {
    progress(10);
    for(const course of data.courses) {const row=await api<Course>('courses','POST',{name:course.name,color:course.color,description:course.description});created.push(row.id);courseIds.set(course.id,row.id);}
    for(const lesson of data.lessons) {const row=await api<LessonDetail>('lessons','POST',{courseId:courseIds.get(lesson.courseId),title:lesson.title,date:lesson.date});lessonIds.set(lesson.id,row.id);}
    const total=data.attachments.reduce((sum,row)=>sum+row.size,0);let uploaded=0;
    for(const attachment of data.attachments) {
      const bytes=archive[`files/${attachment.filename}`];
      const original=new File([Uint8Array.from(bytes)],attachment.filename,{type:attachment.mime});
      const row=await uploadCloud<Attachment>(`lessons/${lessonIds.get(attachment.lessonId)}/attachments`,original,value=>progress(Math.min(95,10+Math.round(80*(uploaded+value/100*attachment.size)/Math.max(1,total)))));
      fileIds.set(attachment.id,row.id);await api(`files/${row.id}`,'PATCH',{name:attachment.name,position:attachment.position});uploaded+=attachment.size;
    }
    for(const lesson of data.lessons) await api(`lessons/${lessonIds.get(lesson.id)}`,'PATCH',{title:lesson.title,date:lesson.date,revision:0,content:mapAttachmentUrls(lesson.content,id=>fileIds.get(id)!)});
    for(const course of data.courses) if(course.archived) await api(`courses/${courseIds.get(course.id)}`,'PATCH',{archived:true});
    progress(100);return {courses:data.courses.length,lessons:data.lessons.length,attachments:data.attachments.length};
  } catch(error) {
    let rollbackFailed=false;for(const id of created.reverse()) await api(`courses/${id}`,'DELETE').catch(()=>{rollbackFailed=true;});
    if(rollbackFailed) throw new Error(`${(error as Error).message}。部分导入未能清理，请刷新后检查新增课程。`);throw error;
  }
}
