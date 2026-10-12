// Reading the manifest out of an Archipelago patch (a zip). Backed by fflate
// so zips written with data descriptors (macOS Archive Utility, Google Drive
// downloads, streaming zippers) parse correctly — those leave the
// local-header sizes at 0 and only the central directory knows the truth.

import { unzipSync } from "fflate";

function readZipEntry(bytes: Uint8Array, targetName: string): Uint8Array {
  const entries = unzipSync(bytes, { filter: (f) => f.name === targetName });
  const data = entries[targetName];
  if (!data) throw new Error(`${targetName} not found in patch`);
  return data;
}

// The patch's archipelago.json. Only a few fields are used; the rest pass
// through.
export type PatchManifest = {
  game?: string;
  world_version?: string;
  minimum_patch_version?: string;
  [key: string]: any;
};

export async function readPatchManifest(patchBytes: Uint8Array): Promise<PatchManifest> {
  return JSON.parse(new TextDecoder().decode(readZipEntry(patchBytes, "archipelago.json")));
}
