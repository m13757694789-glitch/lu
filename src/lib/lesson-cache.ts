import type { LessonDetail } from './models.ts';

// Memory belongs to this authenticated workspace only; no private notes are cached on disk.
export class LessonCache {
  private entries=new Map<string,{detail:LessonDetail;at:number;version:number}>();
  private pending=new Map<string,Promise<LessonDetail>>();
  private generation=new Map<string,number>();
  private fetcher:(id:string)=>Promise<LessonDetail>;private clock:()=>number;private capacity:number;private ttl:number;
  constructor(fetcher:(id:string)=>Promise<LessonDetail>,clock=()=>Date.now(),capacity=12,ttl=300000){this.fetcher=fetcher;this.clock=clock;this.capacity=capacity;this.ttl=ttl;}
  peek(id:string,version=0){const entry=this.entries.get(id);if(!entry||entry.version!==version||this.clock()-entry.at>this.ttl)return;this.entries.delete(id);this.entries.set(id,entry);return entry.detail;}
  remember(detail:LessonDetail,version=0){const old=this.entries.get(detail.id);if(old&&old.detail.revision>detail.revision)return;this.entries.delete(detail.id);this.entries.set(detail.id,{detail,at:this.clock(),version});while(this.entries.size>this.capacity)this.entries.delete(this.entries.keys().next().value!);}
  update(id:string,patch:Partial<LessonDetail>,version?:number){const entry=this.entries.get(id);if(entry)this.remember({...entry.detail,...patch},version??entry.version);}
  invalidate(id:string){this.entries.delete(id);this.generation.set(id,(this.generation.get(id)||0)+1);}
  async read(id:string,version=0,force=false){
    if(!force){const cached=this.peek(id,version);if(cached)return cached;}
    const key=`${id}:${version}:${this.generation.get(id)||0}`,active=this.pending.get(key);if(active)return active;
    const generation=this.generation.get(id)||0;
    const request=this.fetcher(id).then(detail=>{if((this.generation.get(id)||0)===generation)this.remember(detail,version);return detail;}).finally(()=>{if(this.pending.get(key)===request)this.pending.delete(key);});
    this.pending.set(key,request);return request;
  }
}
