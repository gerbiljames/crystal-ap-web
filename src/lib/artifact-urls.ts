import { createMemo, onCleanup } from "solid-js";

// Object URLs for a set of generated artifacts, one per file, rebuilt when
// the set changes. The previous set is revoked then, and on unmount, so the
// (multi-MB) blobs behind download links don't pile up for the tab's life.
export function useArtifactUrls(artifacts: () => Record<string, Uint8Array<ArrayBuffer>> | null | undefined) {
  let live: string[] = [];
  const revoke = () => { for (const u of live) URL.revokeObjectURL(u); live = []; };
  const urls = createMemo(() => {
    revoke();
    const out: Record<string, string> = {};
    for (const [name, bytes] of Object.entries(artifacts() || {})) {
      out[name] = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
      live.push(out[name]);
    }
    return out;
  });
  onCleanup(revoke);
  return urls;
}
