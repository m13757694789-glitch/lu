import { hashUploadFile } from "./upload-hash";
import { UploadSourceError } from './upload-source';

self.onmessage = async (event: MessageEvent<{ file: File; partSize: number }>) => {
  try {
    const hashes=await hashUploadFile(event.data.file,event.data.partSize,false,(index,sha256)=>self.postMessage({index,sha256}));
    self.postMessage({sha256:hashes.sha256});
  }
  catch (error) { self.postMessage({ error: error instanceof UploadSourceError ? error.message : '无法校验录音，请重新选择文件后重试', sourceError: error instanceof UploadSourceError }); }
};
