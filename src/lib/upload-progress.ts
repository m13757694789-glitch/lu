export type UploadTransfer = {
  stage: "preparing" | "uploading" | "verifying" | "saving" | "retrying";
  loaded: number;
  total: number;
  bytesPerSecond?: number;
};
export type TransferObserver = (transfer: UploadTransfer) => void;
