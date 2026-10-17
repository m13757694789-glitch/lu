import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentStorage, privateObjectPath, signR2Upload, r2ObjectUrl } from '../src/lib/r2-storage.ts';
import { storageUploadUrls, transferCloudParts } from '../src/lib/cloud-upload-transfer.ts';

const owner='11111111-1111-4111-8111-111111111111', file='22222222-2222-4222-8222-222222222222';
const environment={CLASSNOTE_ATTACHMENT_STORAGE:'r2',R2_ACCOUNT_ID:'0'.repeat(32),R2_BUCKET:'classnote-private',R2_ACCESS_KEY_ID:'test-access-key',R2_SECRET_ACCESS_KEY:'test-secret-key'};
function mockEnvironment(t:TestContext) {
  const previous=new Map(Object.keys(environment).map(name=>[name,process.env[name]]));
  Object.assign(process.env,environment);
  t.after(()=>{for(const [name,value] of previous) {if(value===undefined)delete process.env[name];else process.env[name]=value;}});
}
test('R2 signed requests bind the owner, size, MIME and atomic no-overwrite condition',async t=>{
  mockEnvironment(t);
  const signed=await signR2Upload(owner,file,1,1234,'audio/mp4');
  const url=new URL(signed.url),headers=url.searchParams.get('X-Amz-SignedHeaders')!.split(';');
  assert.equal(url.origin,`https://${'0'.repeat(32)}.r2.cloudflarestorage.com`);
  assert.equal(url.pathname,`/classnote-private/${owner}/${file}/1`);
  assert.equal(url.searchParams.get('X-Amz-Expires'),'900');
  for(const header of ['content-length','content-type','if-none-match']) assert.ok(headers.includes(header));
  assert.equal(signed.headers['if-none-match'],'*');
  assert.deepEqual(storageUploadUrls(signed),signed);
  const get=new URL(await r2ObjectUrl(owner,file,1,'统计1.m4a'));
  assert.equal(get.searchParams.get('X-Amz-Expires'),'60');
  assert.ok(get.searchParams.get('response-content-disposition')?.includes(encodeURIComponent('统计1.m4a')));
  assert.ok(!get.href.includes('test-secret-key'));
});

test('R2 configuration fails closed and object paths cannot cross the account prefix',t=>{
  mockEnvironment(t);
  assert.equal(attachmentStorage(),'r2');
  assert.equal(privateObjectPath(owner,file,0),`${owner}/${file}/0`);
  for(const [who,id,index] of [['../other',file,0],[owner,'../other',0],[owner,file,-1],[owner,file,256],[owner,file,0.5]] as const) assert.throws(()=>privateObjectPath(who,id,index));
  process.env.R2_ACCOUNT_ID='attacker.example/path'; assert.throws(()=>attachmentStorage(),/尚未配置/);
  process.env.CLASSNOTE_ATTACHMENT_STORAGE='unknown'; assert.throws(()=>attachmentStorage(),/配置无效/);
});

test('upload retries retain the signed R2 headers and never switch away from R2',async()=>{
  const seen:{url:string;headers:Record<string,string>|undefined}[]=[];let count=0;
  await transferCloudParts({id:file,partSize:2,parts:1,mime:'audio/mp4'},new Blob(['ab']),{parts:['hash']},{
    sign:async()=>({url:'https://account.r2.cloudflarestorage.com/key?signature=example',headers:{'if-none-match':'*'}}),pause:async()=>{},
    put:async(url,blob,progress,headers)=>{seen.push({url,headers});if(++count===1)throw Error('network');progress(blob.size);},
    verify:async(_,sha256)=>{if(count===1)throw Error('not ready');return{sha256};},
  },()=>{});
  assert.equal(count,2);assert.deepEqual(seen[0],seen[1]);assert.equal(seen[1].headers?.['if-none-match'],'*');
});
