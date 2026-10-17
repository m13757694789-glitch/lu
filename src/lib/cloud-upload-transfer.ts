import type { TransferObserver, UploadTransfer } from "./upload-progress.ts";

type Plan = { id: string; partSize: number; parts: number; mime: string };
export type SignedPart = { url: string; fallbackUrl?: string; headers?: Record<string,string> };
type Transport = {
  sign: (index: number) => Promise<SignedPart>;
  put: (url: string, blob: Blob, progress: (loaded: number) => void, headers?: Record<string,string>) => Promise<void>;
  verify: (index: number, sha256: string) => Promise<{ sha256: string }>;
  pause?: (attempt: number) => Promise<void>;
};

export function storageUploadUrls(signed: SignedPart): SignedPart {
  const url = new URL(signed.url);
  // Only Supabase's documented project hostname has a corresponding direct storage hostname.
  if (url.protocol !== "https:" || !/^[a-z0-9]+\.supabase\.co$/.test(url.hostname)) return signed;
  const fallbackUrl = url.href;
  url.hostname = url.hostname.replace(".supabase.co", ".storage.supabase.co");
  return { ...signed, url: url.href, fallbackUrl };
}

export async function transferCloudParts(
  plan: Plan, file: Blob, hashes: {parts: readonly (string | Promise<string>)[]}, transport: Transport,
  progress: (value: number) => void, observe?: TransferObserver,
) {
  const loaded = Array<number>(plan.parts).fill(0);
  const states = Array<UploadTransfer["stage"]>(plan.parts).fill("preparing");
  let next = 0; let failure: unknown; let failed = false;
  let lastReport = 0; let sampleAt = performance.now(); let sampleBytes = 0; let speed: number | undefined;
  const report = (force = false) => {
    const now = performance.now(); if (!force && now - lastReport < 250) return;
    lastReport = now;
    const bytes = loaded.reduce((sum, value) => sum + value, 0);
    if (now - sampleAt >= 1000) { speed = Math.max(0, (bytes - sampleBytes) * 1000 / (now - sampleAt)); sampleAt = now; sampleBytes = bytes; }
    const stage = states.includes("uploading") ? "uploading" : states.includes("retrying") ? "retrying" : states.includes("preparing") ? "preparing" : "verifying";
    progress(Math.min(98, Math.floor(bytes / file.size * 98)));
    observe?.({ stage, loaded: bytes, total: file.size, bytesPerSecond: stage === "uploading" ? speed : undefined });
  };
  const pause = transport.pause || (attempt => new Promise(resolve => setTimeout(resolve, attempt * 1000)));
  const verify = async (index: number, expected: string) => {
    states[index] = "verifying"; report(true);
    let error: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const part = await transport.verify(index, expected);
        if (part.sha256 !== expected) throw new Error("上传校验失败，请重新上传原文件");
        return;
      } catch (caught) {
        if(caught instanceof Error && caught.message.includes("校验失败")) throw caught;
        error = caught; if (attempt < 2) { states[index] = "retrying"; report(true); await pause(attempt + 1); }
      }
    }
    throw error;
  };
  const run = async () => {
    while (!failed && next < plan.parts) {
      const index = next++;
      try {
        const expected=await hashes.parts[index];
        const blob = file.slice(index * plan.partSize, Math.min(file.size, (index + 1) * plan.partSize), plan.mime);
        const signed = storageUploadUrls(await transport.sign(index));
        let uploaded = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          states[index] = attempt ? "retrying" : "uploading"; report(true);
          try {
            await transport.put(attempt && signed.fallbackUrl ? signed.fallbackUrl : signed.url, blob, value => {
              loaded[index] = Math.max(loaded[index], Math.min(blob.size, Math.max(0, value))); report();
            },signed.headers);
            uploaded = true; break;
          } catch (uploadError) {
            // A lost PUT acknowledgement may still have stored the immutable object.
            try {
              const part = await transport.verify(index, expected);
              if (part.sha256 === expected) { loaded[index] = blob.size; uploaded = false; break; }
            } catch {}
            if (attempt === 2) throw uploadError;
            states[index] = "retrying"; report(true); await pause(attempt + 1);
          }
        }
        loaded[index] = blob.size;
        if (uploaded) await verify(index,expected);
        states[index] = "saving"; report(true);
      } catch (error) { failed = true; failure ??= error; }
    }
  };
  // Wait for both lanes to settle before the caller can delete failed upload objects.
  // File-level ordering remains serial; only pieces of the same recording overlap.
  await Promise.all([run(), run()]);
  if (failed) throw failure;
}
