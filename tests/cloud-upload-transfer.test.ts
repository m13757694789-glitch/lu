import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { hashUploadFile } from '../src/lib/upload-hash.ts';
import { storageUploadUrls, transferCloudParts } from '../src/lib/cloud-upload-transfer.ts';

const plan={id:'upload',partSize:2,parts:3,mime:'audio/wav'};
const file=new Blob(['abcdef']);
const hashes={parts:['aa','bb','cc'],sha256:'full'};
const pause=async()=>{};
const sign=async(index:number)=>({url:`https://project.supabase.co/${index}`});

test('streaming upload hashes match independent SHA-256 across partial final segments',async()=>{
  const data=Uint8Array.from({length:1024*1024+19},(_,i)=>i%251);
  const size=256*1024;
  const actual=await hashUploadFile(new Blob([data]),size);
  assert.equal(actual.sha256,createHash('sha256').update(data).digest('hex'));
  assert.deepEqual(actual.parts,Array.from({length:Math.ceil(data.length/size)},(_,i)=>createHash('sha256').update(data.subarray(i*size,(i+1)*size)).digest('hex')));
});

test('direct storage routing preserves signature and leaves custom domains alone',()=>{
  const original='https://project.supabase.co/storage/v1/object/upload/sign/path?token=sample';
  const signed=storageUploadUrls({url:original});
  assert.equal(signed.url,'https://project.storage.supabase.co/storage/v1/object/upload/sign/path?token=sample');
  assert.equal(signed.fallbackUrl,original);
  assert.deepEqual(storageUploadUrls({url:'https://storage.example.com/file'}),{url:'https://storage.example.com/file'});
});

test('two lanes overlap transfer and verification, preserve indexes and report monotonic bytes',async()=>{
  let release!:()=>void;let firstVerifying!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  const verifying=new Promise<void>(resolve=>{firstVerifying=resolve;});
  const started:number[]=[];const verified:number[]=[];const values:number[]=[];let active=0,maxActive=0;
  const work=transferCloudParts(plan,file,hashes,{
    sign,pause,
    put:async(url,blob,progress)=>{active++;maxActive=Math.max(active,maxActive);started.push(Number(new URL(url).pathname.slice(1)));progress(blob.size);active--;},
    verify:async(index,sha256)=>{verified.push(index);if(index===0){firstVerifying();await blocked;}return{sha256};},
  },value=>values.push(value));
  await verifying;
  // The second lane can finish another segment while the first waits for cloud verification.
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(started,[0,1,2]);
  release();await work;
  assert.deepEqual(verified.sort(),[0,1,2]);assert(maxActive<=2);
  assert(values.every((value,i)=>value<=98&&(!i||value>=values[i-1])));
});

test('lost PUT acknowledgement verifies once and never uploads a confirmed segment again',async()=>{
  let puts=0,verifies=0;
  await transferCloudParts({...plan,parts:1},new Blob(['ab']),{...hashes,parts:['aa']},{
    sign,pause,put:async()=>{puts++;throw Error('lost acknowledgement');},verify:async(_,sha256)=>{verifies++;return{sha256};},
  },()=>{});
  assert.equal(puts,1);assert.equal(verifies,1);
});

test('ready segments start transferring while later segment hashes are still pending',async()=>{
  let releaseSecond!:(value:string)=>void,releaseThird!:(value:string)=>void,startedFirst!:()=>void;
  const first=new Promise<void>(resolve=>{startedFirst=resolve;});const sent:number[]=[];
  const pending={parts:[Promise.resolve('aa'),new Promise<string>(resolve=>{releaseSecond=resolve;}),new Promise<string>(resolve=>{releaseThird=resolve;})]};
  const work=transferCloudParts(plan,file,pending,{sign,pause,put:async url=>{const index=Number(new URL(url).pathname.slice(1));sent.push(index);if(index===0)startedFirst();},verify:async(_,sha256)=>({sha256})},()=>{});
  await first;assert.deepEqual(sent,[0]);releaseSecond('bb');releaseThird('cc');await work;assert.deepEqual(sent.sort(),[0,1,2]);
});

test('a missing segment retries through the original hostname without restarting its neighbors',async()=>{
  const counts=[0,0,0];const hosts:string[]=[];
  await transferCloudParts(plan,file,hashes,{
    sign,pause,put:async(url,blob,progress)=>{const u=new URL(url),index=Number(u.pathname.slice(1));counts[index]++;if(index===1){hosts.push(u.hostname);if(counts[index]===1)throw Error('network');}progress(blob.size);},
    verify:async(index,sha256)=>{if(index===1&&counts[index]===1)throw Error('not uploaded');return{sha256};},
  },()=>{});
  assert.deepEqual(counts,[1,2,1]);assert.deepEqual(hosts,['project.storage.supabase.co','project.supabase.co']);
});

test('failed lanes settle all in-flight requests before cleanup can run, and never start later parts',async()=>{
  let release!:()=>void;let secondStarted!:()=>void;let ended=false;
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  const second=new Promise<void>(resolve=>{secondStarted=resolve;});const started:number[]=[];
  const work=transferCloudParts(plan,file,hashes,{
    sign,pause,put:async(url)=>{const index=Number(new URL(url).pathname.slice(1));started.push(index);if(index===1){secondStarted();await blocked;}},
    verify:async(index,sha256)=>{if(index===0)throw Error('verification unavailable');return{sha256};},
  },()=>{}).finally(()=>{ended=true;});
  await second;await new Promise(resolve=>setImmediate(resolve));assert.equal(ended,false);
  release();await assert.rejects(work,/verification unavailable/);assert.deepEqual(started,[0,1]);
});

test('integrity mismatches cannot complete the transfer',async()=>{
  await assert.rejects(transferCloudParts({...plan,parts:1},new Blob(['ab']),{...hashes,parts:['expected']},{sign,pause,put:async()=>{},verify:async()=>({sha256:'different'})},()=>{}),/上传校验失败/);
});
