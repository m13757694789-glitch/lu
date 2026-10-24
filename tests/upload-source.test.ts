import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyUploadSource, UploadSourceError } from '../src/lib/upload-source.ts';
import { uploadMetadata } from '../src/lib/upload-metadata.ts';
import { transferCloudParts } from '../src/lib/cloud-upload-transfer.ts';
import { hashUploadFile } from '../src/lib/upload-hash.ts';

test('empty, missing, and truncated sources report a file read problem before upload',async()=>{
  await assert.rejects(verifyUploadSource(new File([],'recording.m4a')),/0 字节/);
  class Missing extends Blob { override slice(): Blob {throw new DOMException('File disappeared','NotFoundError');} }
  await assert.rejects(verifyUploadSource(new Missing(['audio'])),UploadSourceError);
  class Truncated extends Blob { override slice(){return new Blob([]);} }
  await assert.rejects(verifyUploadSource(new Truncated(['audio'])),UploadSourceError);
  assert.equal(await verifyUploadSource(new Blob(['audio'])),5);
  assert.throws(()=>uploadMetadata({name:'10.20电子6.m4a',size:0}),/重新选择文件/);
  assert.equal(uploadMetadata({name:'10.20电子6.m4a',size:88161812}).size,88161812);
});

test('a buffered segment can retry unchanged after the original file disappears',async()=>{
  class Source extends Blob {
    missing=false;
    override slice(start?:number,end?:number,type?:string){if(this.missing)throw new DOMException('gone','NotFoundError');return super.slice(start,end,type);}
  }
  const source=new Source(['ab']);let puts=0;
  await transferCloudParts({id:'file',partSize:2,parts:1,mime:'audio/mp4',size:2},source,{parts:['hash']},{
    sign:async()=>({url:'https://storage.example/part'}),pause:async()=>{},
    put:async(_,blob)=>{assert.equal(await blob.text(),'ab');source.missing=true;if(++puts===1)throw Error('connection lost');},
    verify:async()=>{if(puts===1)throw Error('not received');return {sha256:'hash'};},
  },()=>{});
  assert.equal(puts,2);
});

test('a source lost between segments cannot silently produce a partial file hash',async()=>{
  class Source extends Blob {
    missing=false;
    override get size(){return this.missing?0:super.size;}
    override slice(start?:number,end?:number,type?:string){return this.missing?new Blob([]):super.slice(start,end,type);}
  }
  const source=new Source(['abcd']);
  await assert.rejects(hashUploadFile(source,2,false,()=>{source.missing=true;}),UploadSourceError);
});
