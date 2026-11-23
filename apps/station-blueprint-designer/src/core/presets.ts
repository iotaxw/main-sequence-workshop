/// <reference types="vite/client" />
import { deserializeBlueprint } from './codec';
import type { BlueprintDocument } from './types';

export interface PresetBlueprintEntry {
  /** Posix relative path inside the built-in default blueprint library */
  path: string;
  doc: BlueprintDocument;
  /** True when loaded from local-only `src/data/private-blueprints/` (never included in public open-source releases) */
  isPrivate: boolean;
}

const publicModules = import.meta.glob('../data/default-blueprints/**/*.json', {
  eager: true,
  import: 'default',
});

// Optional private local blueprint library: exists in private dev workspace, excluded by scripts/export-release.ps1
const privateModules = import.meta.glob('../data/private-blueprints/**/*.json', {
  eager: true,
  import: 'default',
});

const PUBLIC_PREFIX = '../data/default-blueprints/';
const PRIVATE_PREFIX = '../data/private-blueprints/';

function loadPresetBlueprints(): PresetBlueprintEntry[] {
  const entries: PresetBlueprintEntry[] = [];
  const ingest = (mods: Record<string, unknown>, prefix: string, isPrivate: boolean) => {
    for (const [key, value] of Object.entries(mods)) {
      const relPath = key.startsWith(prefix) ? key.slice(prefix.length) : key;
      const decoded = deserializeBlueprint(JSON.stringify(value));
      if (!decoded.ok) {
        throw new Error(`Invalid built-in preset blueprint "${relPath}": ${decoded.error}`);
      }
      entries.push({ path: relPath, doc: decoded.doc, isPrivate });
    }
  };
  ingest(publicModules, PUBLIC_PREFIX, false);
  ingest(privateModules, PRIVATE_PREFIX, true);
  entries.sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans'));
  return entries;
}

export const DEFAULT_LIBRARY_PRESETS: PresetBlueprintEntry[] = loadPresetBlueprints();
export const HAS_PRIVATE_PRESETS: boolean = DEFAULT_LIBRARY_PRESETS.some((p) => p.isPrivate);
