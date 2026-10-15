import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, courseSchema, lessonSchema, lessonPatchSchema } from "./validation.ts";
import { mapAttachmentUrls, textOf, type Attachment, type Course, type Lesson, type Library } from "./models.ts";

export type CloudAttachment = Attachment & { part_size: number; ready: boolean };
export type CloudPart = { attachment_id: string; part_no: number; path: string; size: number; sha256: string };
const courseColumns = 'id,name,color,description,archived,createdAt';
const lessonColumns = 'id,courseId,title,date,revision,createdAt,updatedAt,visitedAt';
const fileColumns = 'id,lessonId,name,kind,mime,size,filename,sha256,position,createdAt,part_size,ready';
export function databaseError(error: { code?: string; message: string }) {
  if (error.message.includes("storage_quota_exceeded")) throw new AppError("免费私有空间最多保存 1 GB 附件。请先备份并清理不用的附件。", 413);
  if (error.message.includes("upload_incomplete")) throw new AppError("文件还没有完整上传，请重试", 409);
  if (error.code === "23503") throw new AppError("关联的课程或课堂已被删除，请重新打开", 409);
  if (error.code === "42501") throw new AppError("当前账号没有访问这些资料的权限", 403);
  throw new AppError("云端存储暂时无法响应，请稍后重试。", 503);
}
export async function checked<T>(query: PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>): Promise<T> {
  const result = await query; if (result.error) databaseError(result.error);
  const normalize=(value:unknown)=>{if(value&&typeof value==='object'&&!Array.isArray(value)){const row={...value} as Record<string,unknown>;for(const key of ['createdAt','updatedAt','visitedAt']) if(typeof row[key]==='string') row[key]=new Date(row[key]).toISOString();return row;}return value;};
  return (Array.isArray(result.data)?result.data.map(normalize):normalize(result.data)) as T;
}
export async function checkedAll<T>(query: (start: number, end: number) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let start = 0; ; start += 1000) {
    const page = await checked<T[]>(query(start, start + 999));
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

export class CloudStore {
  readonly client: SupabaseClient;
  readonly owner: string;
  constructor(client: SupabaseClient, owner: string) { this.client = client; this.owner = owner; }
  async course(id: string) {
    const result = await checked<Course | null>(this.client.from('cn_courses').select(courseColumns).eq('id',id).maybeSingle());
    if (!result) throw new AppError("课程不存在",404); return result;
  }
  async lesson(id: string) {
    const result = await checked<Lesson | null>(this.client.from('cn_lessons').select(`${lessonColumns},content`).eq('id',id).maybeSingle());
    if (!result) throw new AppError("课堂记录不存在",404); return result;
  }
  async attachment(id: string, pending = false) {
    const result = await checked<CloudAttachment | null>(this.client.from('cn_attachments').select(fileColumns).eq('id',id).maybeSingle());
    if (!result || (!pending && !result.ready)) throw new AppError("附件不存在",404); return result;
  }
  async parts(id: string) { return checked<CloudPart[]>(this.client.from('cn_file_parts').select('attachment_id,part_no,path,size,sha256').eq('attachment_id',id).order('part_no')); }
  async library(): Promise<Library> {
    const courses: Course[] = []; const lessons: Lesson[] = [];
    for (let offset=0;;offset+=1000) {
      const rows=await checked<Course[]>(this.client.from('cn_courses').select(courseColumns).order('createdAt').range(offset,offset+999));
      courses.push(...rows); if(rows.length<1000) break;
    }
    for (let offset=0;;offset+=1000) {
      const rows=await checked<Omit<Lesson,'content'>[]>(this.client.from('cn_lessons').select(lessonColumns).order('date',{ascending:false}).order('createdAt',{ascending:false}).range(offset,offset+999));
      lessons.push(...rows.map(row=>({...row,content:[]}))); if(rows.length<1000) break;
    }
    const setting = await checked<{value:Record<string,unknown>}|null>(this.client.from('cn_settings').select('value').eq('owner_id',this.owner).maybeSingle());
    return {courses,lessons,settings:setting?.value||{}};
  }
  async search(query: string) {
    return checked<string[]>(this.client.rpc('cn_search_lessons',{needle:query}));
  }
  async detail(id: string, visit = false) {
    if (visit) await checked(this.client.from('cn_lessons').update({visitedAt:new Date().toISOString()}).eq('id',id));
    const [lesson,attachments] = await Promise.all([this.lesson(id),checkedAll<Attachment>((start,end)=>this.client.from('cn_attachments').select(fileColumns).eq('lessonId',id).eq('ready',true).order('createdAt').order('id').range(start,end))]);
    return {...lesson,attachments};
  }
  async createCourse(input: unknown) {
    const data=courseSchema.parse(input);
    return checked<Course>(this.client.from('cn_courses').insert({id:randomUUID(),...data}).select(courseColumns).single());
  }
  async updateCourse(id: string,input: unknown) {
    const data=courseSchema.partial().extend({color:z.string().regex(/^#[\da-f]{6}$/i).optional(),description:z.string().max(2000).optional(),archived:z.boolean().optional()}).parse(input);
    const patch={...data,archived:data.archived===undefined?undefined:Number(data.archived)};
    await this.course(id); return checked<Course>(this.client.from('cn_courses').update(patch).eq('id',id).select(courseColumns).single());
  }
  async createLesson(input: unknown) {
    const data=lessonSchema.parse(input); await this.course(data.courseId);
    const row = await checked<Lesson>(this.client.from('cn_lessons').insert({id:randomUUID(),...data,content:[{id:randomUUID(),type:'paragraph',content:[]}]}).select(`${lessonColumns},content`).single());
    return {...row,attachments:[]};
  }
  async updateLesson(id: string,input: unknown) {
    const data=lessonPatchSchema.parse(input); const old=await this.lesson(id);
    if(data.courseId) await this.course(data.courseId);
    if(data.content) {
      const ids=new Set<string>(); mapAttachmentUrls(data.content,attachmentId=>{ids.add(attachmentId);return attachmentId;});
      for(const attachmentId of ids) if((await this.attachment(attachmentId)).lessonId!==id) throw new AppError("图片必须属于当前课堂，请重新上传");
    }
    const patch={courseId:data.courseId??old.courseId,title:data.title??old.title,date:data.date??old.date,content:data.content??old.content,
      search_text:textOf(data.content??old.content),revision:data.revision+1,updatedAt:new Date().toISOString()};
    const row=await checked<Lesson|null>(this.client.from('cn_lessons').update(patch).eq('id',id).eq('revision',data.revision).select(`${lessonColumns},content`).maybeSingle());
    if(!row) throw new AppError("这节课已在其他窗口修改。当前草稿已保留，请先导出草稿，再重新加载。",409); return row;
  }
  async updateAttachment(id:string,input:unknown) {
    const data=z.object({name:z.string().trim().min(1).max(240).optional(),position:z.number().finite().min(0).max(1e8).optional()}).parse(input);
    await this.attachment(id); return checked<Attachment>(this.client.from('cn_attachments').update(data).eq('id',id).select(fileColumns).single());
  }
  async settings(input:unknown) { const data=z.record(z.string().max(100),z.unknown()).parse(input); await checked(this.client.rpc('cn_patch_settings',{patch:data})); }
}
