import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioUploadQueue } from '../src/lib/audio-upload-queue.ts';
import type { Attachment } from '../src/lib/models.ts';
const file=(name:string)=>new File(['test'],name);
const target=(lessonId:string)=>({lessonId,lessonTitle:lessonId,courseId:'course-A'});
const result=(lessonId:string,name:string)=>({id:crypto.randomUUID(),lessonId,name} as Attachment);
async function settled(queue:AudioUploadQueue){if(!queue.hasPending())return;await new Promise<void>(resolve=>{const stop=queue.subscribe(()=>{if(!queue.hasPending()){stop();resolve();}});});}

test('queued recordings keep their original lesson and selection order while views change',async()=>{
  let finish!:()=>void;const started:string[]=[];
  const queue=new AudioUploadQueue(async(lessonId,upload,progress)=>{started.push(`${lessonId}/${upload.name}`);progress(100);if(started.length===1)await new Promise<void>(resolve=>{finish=resolve;});return result(lessonId,upload.name);});
  queue.enqueue(target('lesson-A'),file('1.wav'));queue.enqueue(target('lesson-A'),file('2.wav'));queue.enqueue(target('lesson-B'),file('3.wav'));
  assert.equal(queue.getSnapshot()[0].progress,99);assert.equal(queue.getSnapshot()[0].status,'uploading');
  assert.deepEqual(started,['lesson-A/1.wav']);assert(queue.hasPending({lessonId:'lesson-B'}));
  finish();await settled(queue);
  assert.deepEqual(started,['lesson-A/1.wav','lesson-A/2.wav','lesson-B/3.wav']);
  assert.equal(queue.completionVersion('lesson-A'),2);assert.equal(queue.completionVersion('lesson-B'),1);
  queue.clearCompleted();assert.equal(queue.getSnapshot().length,0);assert.equal(queue.completionVersion('lesson-A'),2);
});
test('a failed recording keeps retry information while later jobs can complete',async()=>{
  let fail=true;const queue=new AudioUploadQueue(async(lessonId,upload)=>{if(upload.name==='1.wav'&&fail)throw new Error('network failed');return result(lessonId,upload.name);});
  const id=queue.enqueue(target('A'),file('1.wav'));queue.enqueue(target('B'),file('2.wav'));await settled(queue);
  assert.equal(queue.getSnapshot()[0].status,'failed');assert.equal(queue.getSnapshot()[1].status,'completed');
  fail=false;queue.retry(id);await settled(queue);assert.equal(queue.getSnapshot()[0].status,'completed');
});
test('replacement failure never deletes the old file and cleanup failure never reuploads a durable new file',async()=>{
  let uploads=0;let deletes=0;const queue=new AudioUploadQueue(async(lessonId,upload)=>{uploads++;if(uploads===1)throw new Error('interrupted');return result(lessonId,upload.name);},async()=>{deletes++;throw new Error('delete failed');});
  const id=queue.enqueue(target('A'),file('new.wav'),'old-id');await settled(queue);assert.equal(deletes,0);
  queue.retry(id);await settled(queue);assert.equal(deletes,1);assert.equal(queue.getSnapshot()[0].status,'completed');assert.match(queue.getSnapshot()[0].warning!,/旧录音未能删除/);
  queue.retry(id);await settled(queue);assert.equal(uploads,2);
});
