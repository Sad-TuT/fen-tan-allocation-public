const MAX_CONCURRENT_UPLOADS = 2;

let activeUploads = 0;

/**
 * XLSX validation is CPU and memory intensive. Refuse extra parsing work
 * instead of queueing large request bodies behind the Node event loop.
 */
export function tryAcquireUploadSlot(): (() => void) | null {
  if (activeUploads >= MAX_CONCURRENT_UPLOADS) return null;
  activeUploads += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeUploads = Math.max(0, activeUploads - 1);
  };
}

export function activeUploadCountForTest(): number {
  return activeUploads;
}
