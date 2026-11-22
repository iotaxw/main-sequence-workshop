/// <reference types="vite/client" />
import { deserializeBlueprint } from './codec';
import type { BlueprintDocument } from './types';

export interface PresetBlueprintEntry {
  /** Posix relative path inside the built-in default blueprint library */
  path: string;
  doc: BlueprintDocument;
}

const rawModules = import.meta.glob('../data/default-blueprints/**/*.json', {
  eager: true,
  import: 'default',
});

const PREFIX = '../data/default-blueprints/';

function loadPresetBlueprints(): PresetBlueprintEntry[] {
  const entries: PresetBlueprintEntry[] = [];
  for (const [key, value] of Object.entries(rawModules)) {
    const relPath = key.startsWith(PREFIX) ? key.slice(PREFIX.length) : key;
    const decoded = deserializeBlueprint(JSON.stringify(value));
    if (!decoded.ok) {
      throw new Error(`Invalid built-in preset blueprint "${relPath}": ${decoded.error}`);
    }
    entries.push({ path: relPath, doc: decoded.doc });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans'));
  return entries;
}

export const DEFAULT_LIBRARY_PRESETS: PresetBlueprintEntry[] = loadPresetBlueprints();
