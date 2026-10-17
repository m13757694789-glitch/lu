import test from 'node:test';
import assert from 'node:assert/strict';
import { LessonCache } from '../src/lib/lesson-cache.ts';
import type { LessonDetail } from '../src/lib/models.ts';
const row=(id:string,revision=0)=>({id,revision,content:[],attachments:[]} as unknown as LessonDetail);

test('hover prefetch and click share one request; recently opened notes read without another round trip',async()=>{
  let release!:(value:LessonDetail)=>void,calls=0;
  const cache=new LessonCache(async()=>{calls++;return new Promise(resolve=>{release=resolve;});});
  const hover=cache.read('a'),click=cache.read('a');assert.equal(calls,1);
  release(row('a'));await Promise.all([hover,click]);assert.equal((await cache.read('a')).id,'a');assert.equal(calls,1);
});
test('expiry, upload completion and LRU eviction refresh only affected entries',async()=>{
  let now=0,calls=0;const cache=new LessonCache(async id=>{calls++;return row(id);},()=>now,2,30);
  await cache.read('a');await cache.read('b');cache.peek('a');await cache.read('c');assert.equal(cache.peek('b'),undefined);assert(cache.peek('a'));
  assert.equal(cache.peek('a',1),undefined);await cache.read('a',1);assert.equal(calls,4);
  now=31;assert.equal(cache.peek('a',1),undefined);await cache.read('a',1);assert.equal(calls,5);
});
test('a late prefetch cannot resurrect an invalidated note or overwrite a newer saved revision',async()=>{
  let release!:(value:LessonDetail)=>void;const cache=new LessonCache(async()=>new Promise(resolve=>{release=resolve;}));
  const stale=cache.read('a');cache.invalidate('a');release(row('a'));await stale;assert.equal(cache.peek('a'),undefined);
  cache.remember(row('a',3));cache.remember(row('a',2));assert.equal(cache.peek('a')?.revision,3);
  cache.update('a',{title:'saved title'});assert.equal(cache.peek('a')?.title,'saved title');
});
