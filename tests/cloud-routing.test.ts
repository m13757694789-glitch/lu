import test from 'node:test';
import assert from 'node:assert/strict';
import { storageMode, guardCloud, handleRequest } from '../src/lib/api-router.ts';
import { byteRange } from '../src/lib/ranges.ts';

test('public deployments fail closed without cloud configuration and never import SQLite',async()=>{
  const old=process.env.CLASSNOTE_STORAGE;delete process.env.CLASSNOTE_STORAGE;
  try {
    const response=await handleRequest(new Request('https://lu.gucanyuexuchen.top/api/library'));
    assert.equal(response.status,503);assert.match((await response.json()).error,/私有存储尚未配置/);
    assert.equal(storageMode(new Request('http://127.0.0.1:3210/api/library')),'local');
  }finally{if(old===undefined)delete process.env.CLASSNOTE_STORAGE;else process.env.CLASSNOTE_STORAGE=old;}
});
test('cloud request guard rejects mismatched origin and cross-site requests',()=>{
  const old=process.env.CLASSNOTE_ORIGIN;process.env.CLASSNOTE_ORIGIN='https://lu.gucanyuexuchen.top';
  try {
    assert.doesNotThrow(()=>guardCloud(new Request('https://lu.gucanyuexuchen.top/api/library')));
    assert.throws(()=>guardCloud(new Request('https://other.example/api/library')));
    assert.throws(()=>guardCloud(new Request('https://lu.gucanyuexuchen.top/api/courses',{method:'POST',headers:{Origin:'https://other.example'}})));
    assert.throws(()=>guardCloud(new Request('https://lu.gucanyuexuchen.top/api/courses',{headers:{'sec-fetch-site':'cross-site'}})));
  }finally{if(old===undefined)delete process.env.CLASSNOTE_ORIGIN;else process.env.CLASSNOTE_ORIGIN=old;}
});
test('bounded cloud audio ranges preserve full-file offsets across storage parts',()=>{
  const size=86400044;const max=4*1024**2;
  assert.deepEqual(byteRange('bytes=33554430-33554440',size,max),{start:33554430,end:33554440});
  assert.deepEqual(byteRange('bytes=40000000-',size,max),{start:40000000,end:40000000+max-1});
  assert.deepEqual(byteRange('bytes=-44',size,max),{start:size-44,end:size-1});
  for(const value of ['bytes=-0','bytes=86400044-','bytes=1-0','bytes=0-1,4-5','bytes=a-b']) assert.equal(byteRange(value,size,max),null);
});
