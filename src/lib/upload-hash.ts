import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { readUploadBytes, uploadSourceSize } from './upload-source.ts';

export type UploadHashes = { parts: string[]; sha256: string };

// Read one storage segment at a time, never the entire recording. Emit each hash before
// the slower incremental full-file hash so its upload can start immediately.
export async function hashUploadFile(file: Blob, partSize: number, yieldToUI = false, onPart?: (index: number, digest: string) => void): Promise<UploadHashes> {
  const size = uploadSourceSize(file), full = sha256.create(); const parts: string[] = [];
  for (let offset = 0; offset < size; offset += partSize) {
    const content = await readUploadBytes(file, offset, Math.min(size, offset + partSize));
    const digest = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', content)));
    parts.push(digest); onPart?.(parts.length - 1, digest);
    for (let start = 0; start < content.length; start += 512 * 1024) {
      full.update(content.subarray(start, start + 512 * 1024));
      if (yieldToUI) await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  return { parts, sha256: bytesToHex(full.digest()) };
}
