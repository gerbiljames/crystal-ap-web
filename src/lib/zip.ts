// ZIP reading for AP artifacts (.apcrystalpre patches and the canonical
// output zip). Backed by fflate so zips written with data descriptors (macOS
// Archive Utility, Google Drive downloads, streaming zippers) parse correctly
// — those leave the local-header sizes at 0 and only the central directory
// knows the truth.

import { unzipSync } from "fflate";

export const isPatchName = (n: string) => /\.apcrystal(pre)?$/i.test(n);

// Read a single entry out of a .apcrystalpre (zip).
export async function readZipEntry(bytes: Uint8Array, targetName: string): Promise<Uint8Array> {
  const entries = unzipSync(bytes, { filter: (f) => f.name === targetName });
  const data = entries[targetName];
  if (!data) throw new Error(`${targetName} not found in patch`);
  return data;
}

// Archipelago patch manifests carry slot/server hints. We only use a couple
// of fields; declare them narrow and let the rest pass through.
export type PatchManifest = {
  player_name?: string;
  server?: string;
  [key: string]: any;
};

export async function readPatchManifest(patchBytes: Uint8Array): Promise<PatchManifest> {
  const raw = await readZipEntry(patchBytes, "archipelago.json");
  return JSON.parse(new TextDecoder().decode(raw));
}

// Extract every file in a zip. Used when the user drops the full AP output
// zip (patch + multidata + spoiler), so we can host the multidata on
// archipelago.gg even when we didn't generate it ourselves. Directory entries
// are dropped; nothing downstream wants them.
export async function extractAllZipEntries(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  const entries = unzipSync(bytes, { filter: (f) => !f.name.endsWith("/") });
  return { ...entries };
}
