import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { orderedLessons, reorderedLessonIds, lessonOrderKey, LessonOrderQueue } from '../src/lib/lesson-order.ts';
import { Store } from '../src/lib/storage.ts';

const row = (id:string,courseId='A',createdAt=id) => ({id,courseId,createdAt});
const ids = (rows:readonly {id:string}[]) => rows.map(row=>row.id);
async function settled(queue:LessonOrderQueue) {
  if(!queue.hasPending())return;
  await new Promise<void>(resolve=>{const stop=queue.subscribe(()=>{if(!queue.hasPending()){stop();resolve();}});});
}

test('manual order ignores deleted, moved, duplicate and invalid entries and appends new records',()=>{
  const rows=[row('3'),row('1'),row('2'),row('4'),row('other','B')];
  const result=orderedLessons(rows,'A',{[lessonOrderKey('A')]:['2','deleted','other','1','2',null]});
  assert.deepEqual(ids(result),['2','1','3','4']);
  assert.deepEqual(ids(rows),['3','1','2','4','other']);
  assert.deepEqual(ids(orderedLessons(rows,'B',{[lessonOrderKey('A')]:['2','1']})),['other']);
});

test('adding-time modes remain deterministic and do not erase the saved manual sequence',()=>{
  const rows=[row('b','A','same'),row('a','A','same'),row('c','A','z')],manual={[lessonOrderKey('A')]:['c','b','a']};
  assert.deepEqual(ids(orderedLessons(rows,'A',{})),['a','b','c']);
  assert.deepEqual(ids(orderedLessons(rows,'A',{...manual,lessonSortMode:'newest'})),['c','b','a']);
  assert.deepEqual(ids(orderedLessons(rows,'A',{...manual,lessonSortMode:'oldest'})),['a','b','c']);
  assert.deepEqual(ids(orderedLessons(rows,'A',{...manual,lessonSortMode:'manual'})),['c','b','a']);
  assert.deepEqual(ids(orderedLessons(rows,'A',{[lessonOrderKey('A')]:'corrupt'})),['a','b','c']);
});

test('drag/drop can move before or after a neighbor while rejecting cross-course and missing targets',()=>{
  const rows=[row('1'),row('2'),row('3'),row('x','B')];
  assert.deepEqual(reorderedLessonIds(rows,'3','1','before'),['3','1','2']);
  assert.deepEqual(reorderedLessonIds(rows,'1','3','after'),['2','3','1']);
  for(const [source,target] of [['1','1'],['1','x'],['missing','2'],['2','missing']])assert.equal(reorderedLessonIds(rows,source,target,'before'),null);
});

test('fast repeated moves stay immediate, serialize and coalesce saves, and preserve unrelated settings',async()=>{
  const a=lessonOrderKey('A'),b=lessonOrderKey('B'),calls:Record<string,unknown>[]=[];
  let release!:()=>void;let server:Record<string,unknown>={theme:'dark',lastLesson:'original',[a]:['1','2','3']};
  const queue=new LessonOrderQueue(async patch=>{calls.push(patch);if(calls.length===1)await new Promise<void>(resolve=>{release=resolve;});server={...server,...patch};});
  queue.load(server);queue.enqueue({lessonSortMode:'manual',[a]:['3','1','2']});
  queue.enqueue({lessonSortMode:'manual',[a]:['2','3','1']});queue.enqueue({[b]:['b2','b1']});
  queue.load({[a]:['stale']});
  assert.deepEqual(queue.getSnapshot().settings[a],['2','3','1']);assert.equal(calls.length,1);
  release();await settled(queue);
  assert.equal(calls.length,2);assert.deepEqual(server[a],['2','3','1']);assert.deepEqual(server[b],['b2','b1']);
  assert.equal(server.theme,'dark');assert.equal(server.lastLesson,'original');assert.equal(queue.getSnapshot().error,'');
});

test('failed saves restore the acknowledged order without reverting a later queued move',async()=>{
  const key=lessonOrderKey('A');let rejectFirst!:(error:Error)=>void;let count=0;
  const queue=new LessonOrderQueue(async()=>{if(++count===1)await new Promise((_,reject)=>{rejectFirst=reject;});});
  queue.load({[key]:['1','2','3']});queue.enqueue({[key]:['3','1','2']});
  rejectFirst(new Error('offline'));await settled(queue);
  assert.deepEqual(queue.getSnapshot().settings[key],['1','2','3']);assert.match(queue.getSnapshot().error,/未能保存/);
  let release!:(error:Error)=>void;let calls=0;
  const queued=new LessonOrderQueue(async()=>{if(++calls===1)await new Promise((_,reject)=>{release=reject;});});
  queued.load({[key]:['1','2','3']});queued.enqueue({[key]:['3','1','2']});queued.enqueue({[key]:['2','3','1']});
  release(new Error('first request lost'));await settled(queued);
  assert.deepEqual(queued.getSnapshot().settings[key],['2','3','1']);assert.equal(queued.getSnapshot().error,'');
});

test('a custom sequence survives reopening SQLite without changing lessons or other settings',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'classnote-order-'));let store=new Store(dir);
  try {
    const course=store.createCourse({name:'A'}),other=store.createCourse({name:'B'});
    const a=store.createLesson({courseId:course.id,title:'1',date:'2026-11-03'}),b=store.createLesson({courseId:course.id,title:'2',date:'2026-11-03'});
    const x=store.createLesson({courseId:other.id,title:'other',date:'2026-11-03'});
    store.settings({theme:'light',lastLesson:x.id});
    const queue=new LessonOrderQueue(async patch=>store.settings(patch));queue.load(store.library().settings);
    queue.enqueue({lessonSortMode:'manual',[lessonOrderKey(course.id)]:[b.id,a.id]});await settled(queue);
    store.close();store=new Store(dir);const library=store.library();
    assert.deepEqual(ids(orderedLessons(library.lessons,course.id,library.settings)),[b.id,a.id]);
    assert.equal(library.settings.lastLesson,x.id);assert.equal(library.settings.theme,'light');
    assert.equal(store.lesson(a.id).revision,0);assert.deepEqual(store.lesson(a.id).content,a.content);assert.equal(store.lesson(x.id).courseId,other.id);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
