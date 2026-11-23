import { deserializeBlueprint, serializeBlueprint, createStarterBlueprint } from './codec';
import { getDocumentFloorRange } from './geometry';
import { DEFAULT_LIBRARY_PRESETS } from './presets';
import type { BlueprintDocument, LibraryFileEntry, LibraryFolderEntry, LibraryNode } from './types';

export interface BlueprintLibraryDriver {
  readonly mode: 'fs-local' | 'virtual-idb';
  readonly rootLabel: string;
  listTree(): Promise<LibraryNode[]>;
  readBlueprint(relPath: string): Promise<{ doc: BlueprintDocument; warnings: string[] }>;
  writeBlueprint(relPath: string, doc: BlueprintDocument): Promise<void>;
  createFolder(relPath: string): Promise<void>;
  deleteEntry(relPath: string): Promise<void>;
  moveEntry(fromPath: string, toPath: string): Promise<void>;
}

const AUTOSAVE_KEY = 'ms-sbd:autosave:v2';

export interface AutosaveRecord {
  savedAt: number;
  sourcePath: string | null;
  doc: BlueprintDocument;
  dirty?: boolean;
  presetRevision?: number;
}

function cloneDoc(doc: BlueprintDocument): BlueprintDocument {
  return typeof structuredClone === 'function' ? structuredClone(doc) : (JSON.parse(JSON.stringify(doc)) as BlueprintDocument);
}

/**
 * Compact JSON serializer for browser localStorage persistence (avoids 4x pretty-print bloat on 26k+ building blueprints).
 * Disk exports via FileSystemFolderDriver still use human-readable `serializeBlueprint(doc)`.
 */
function serializeCompact(doc: BlueprintDocument): string {
  return JSON.stringify(doc);
}

let cachedBuiltinMap: Map<string, BlueprintDocument> | null = null;

function getBuiltinPresetMap(): Map<string, BlueprintDocument> {
  if (cachedBuiltinMap) return cachedBuiltinMap;
  const map = new Map<string, BlueprintDocument>();
  const starter = createStarterBlueprint();
  const subLine: BlueprintDocument = {
    format: 'station-blueprint-designer',
    formatVersion: 2,
    id: 'bp_sample_refinery_pair',
    name: '双精炼标准单元',
    gameData: starter.gameData,
    modules: [],
    buildings: [
      { id: 's_r1', type: 'DAT_Refinery', x: 0, y: 0, floor: 0, rotation: 0, recipeId: 'REC_TitaniumBar', disabledPorts: [1, 3] },
      { id: 's_r2', type: 'DAT_Refinery', x: 0, y: 4, floor: 0, rotation: 0, recipeId: 'REC_TitaniumBar', disabledPorts: [1, 3] },
      { id: 's_b1', type: 'DAT_ConveyorBelt', x: 3, y: 1, floor: 0, rotation: 1 },
      { id: 's_b2', type: 'DAT_ConveyorBelt', x: 3, y: 2, floor: 0, rotation: 1 },
      { id: 's_b3', type: 'DAT_ConveyorBelt', x: 3, y: 3, floor: 0, rotation: 0 },
      { id: 's_b4', type: 'DAT_ConveyorBelt', x: 3, y: 5, floor: 0, rotation: 3 },
      { id: 's_b5', type: 'DAT_ConveyorBelt', x: 3, y: 4, floor: 0, rotation: 3 },
    ],
  };
  map.set('整站方案/双层装配枢纽.json', starter);
  map.set('产线子蓝图/双精炼标准单元.json', subLine);
  for (const preset of DEFAULT_LIBRARY_PRESETS) {
    map.set(normalizeRelPath(preset.path), preset.doc);
  }
  cachedBuiltinMap = map;
  return map;
}

export function saveWorkspaceAutosave(doc: BlueprintDocument, sourcePath: string | null, dirty = false): number {
  const savedAt = Date.now();
  const normSource = sourcePath ? normalizeRelPath(sourcePath) : null;
  const builtins = getBuiltinPresetMap();
  // Copy-on-write: if opening an unmodified built-in preset (including 26k+ building full-belts master!),
  // store a tiny ~140-byte presetRef instead of duplicating megabytes into 5 MB browser localStorage!
  if (normSource && !dirty && builtins.has(normSource)) {
    const payload = JSON.stringify({
      savedAt,
      sourcePath,
      dirty: false,
      presetRevision: CURRENT_PRESET_REVISION,
      presetRef: normSource,
    });
    try {
      localStorage.setItem(AUTOSAVE_KEY, payload);
    } catch {
      // Ignore storage quota failure on tiny metadata write
    }
    return savedAt;
  }
  const payload = JSON.stringify({
    savedAt,
    sourcePath,
    dirty,
    presetRevision: CURRENT_PRESET_REVISION,
    raw: serializeCompact(doc),
  });
  try {
    localStorage.setItem(AUTOSAVE_KEY, payload);
  } catch {
    // Fallback: if an enormous dirty blueprint exceeds browser localStorage quota (~5 MB),
    // preserve the source pointer without crashing the editor UI.
    if (normSource) {
      try {
        localStorage.setItem(
          AUTOSAVE_KEY,
          JSON.stringify({
            savedAt,
            sourcePath,
            dirty: false,
            presetRevision: CURRENT_PRESET_REVISION,
            presetRef: builtins.has(normSource) ? normSource : undefined,
          })
        );
      } catch {
        // Ignore secondary quota failure
      }
    }
  }
  return savedAt;
}

export function loadWorkspaceAutosave(): AutosaveRecord | null {
  try {
    const text = localStorage.getItem(AUTOSAVE_KEY);
    if (!text) return null;
    const parsed = JSON.parse(text) as {
      savedAt?: number;
      sourcePath?: string | null;
      dirty?: boolean;
      presetRevision?: number;
      presetRef?: string;
      raw?: string;
    };
    if (!parsed) return null;
    const sourcePath = typeof parsed.sourcePath === 'string' ? parsed.sourcePath : null;
    const builtins = getBuiltinPresetMap();

    // Fast path: lightweight preset reference (zero localStorage bloat!)
    if (typeof parsed.presetRef === 'string') {
      const refDoc = builtins.get(normalizeRelPath(parsed.presetRef));
      if (refDoc) {
        return {
          savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : Date.now(),
          sourcePath,
          dirty: false,
          presetRevision: CURRENT_PRESET_REVISION,
          doc: cloneDoc(refDoc),
        };
      }
    }

    if (typeof parsed.raw !== 'string') return null;
    // If an unmodified built-in preset was open in the previous session and built-in presets upgraded,
    // automatically load the freshly updated preset instead of showing stale pre-fix cached geometry!
    if (sourcePath && !parsed.dirty && (parsed.presetRevision ?? 0) < CURRENT_PRESET_REVISION) {
      const norm = normalizeRelPath(sourcePath);
      const freshPreset = builtins.get(norm);
      if (freshPreset) {
        return {
          savedAt: Date.now(),
          sourcePath,
          dirty: false,
          presetRevision: CURRENT_PRESET_REVISION,
          doc: cloneDoc(freshPreset),
        };
      }
    }
    const decoded = deserializeBlueprint(parsed.raw);
    if (!decoded.ok) return null;
    return {
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : Date.now(),
      sourcePath,
      dirty: Boolean(parsed.dirty),
      presetRevision: parsed.presetRevision,
      doc: decoded.doc,
    };
  } catch {
    return null;
  }
}

export function normalizeRelPath(p: string): string {
  return p
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => seg.trim())
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
}

export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  const base = cleaned || 'blueprint';
  return base.toLowerCase().endsWith('.json') ? base : `${base}.json`;
}

function summarizeDoc(relPath: string, doc: BlueprintDocument, updatedAt: number): LibraryFileEntry {
  const segs = relPath.split('/');
  const fileName = segs[segs.length - 1];
  const range = getDocumentFloorRange(doc);
  return {
    kind: 'file',
    path: relPath,
    name: fileName.replace(/\.json$/i, ''),
    fileName,
    blueprintName: doc.name,
    moduleCount: doc.modules.length,
    buildingCount: doc.buildings.length,
    floorSpan: Math.max(1, range.max - range.min + 1),
    updatedAt,
  };
}

function sortNodes(nodes: LibraryNode[]): LibraryNode[] {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hans');
  });
  for (const n of nodes) {
    if (n.kind === 'folder') sortNodes(n.children);
  }
  return nodes;
}

/**
 * Native Local Folder Driver via Browser File System Access API (`showDirectoryPicker`).
 * Reads and writes real folders & `.json` blueprint files directly on the user's disk, 100% offline.
 */
export class FileSystemFolderDriver implements BlueprintLibraryDriver {
  readonly mode = 'fs-local' as const;
  readonly rootLabel: string;
  private root: FileSystemDirectoryHandle;

  constructor(root: FileSystemDirectoryHandle) {
    this.root = root;
    this.rootLabel = root.name;
  }

  static isSupported(): boolean {
    return typeof window !== 'undefined' && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
  }

  static async pickDirectory(): Promise<FileSystemFolderDriver> {
    const picker = (window as unknown as {
      showDirectoryPicker: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
    }).showDirectoryPicker;
    const handle = await picker({ mode: 'readwrite' });
    return new FileSystemFolderDriver(handle);
  }

  async listTree(): Promise<LibraryNode[]> {
    return this.scanDir(this.root, '');
  }

  private async scanDir(dir: FileSystemDirectoryHandle, prefix: string): Promise<LibraryNode[]> {
    const nodes: LibraryNode[] = [];
    const entries = (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
    for await (const [name, handle] of entries) {
      if (name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === 'directory') {
        const children = await this.scanDir(handle as FileSystemDirectoryHandle, rel);
        nodes.push({ kind: 'folder', path: rel, name, children });
      } else if (handle.kind === 'file' && name.toLowerCase().endsWith('.json')) {
        try {
          const file = await (handle as FileSystemFileHandle).getFile();
          const text = await file.text();
          const decoded = deserializeBlueprint(text);
          if (decoded.ok) {
            nodes.push(summarizeDoc(rel, decoded.doc, file.lastModified));
          }
        } catch {
          // Ignore unreadable non-blueprint json
        }
      }
    }
    return sortNodes(nodes);
  }

  private async resolveDir(folderPath: string, create: boolean): Promise<FileSystemDirectoryHandle> {
    const norm = normalizeRelPath(folderPath);
    if (!norm) return this.root;
    let cur = this.root;
    for (const seg of norm.split('/')) {
      cur = await cur.getDirectoryHandle(seg, { create });
    }
    return cur;
  }

  async readBlueprint(relPath: string): Promise<{ doc: BlueprintDocument; warnings: string[] }> {
    const norm = normalizeRelPath(relPath);
    const parts = norm.split('/');
    const fileName = parts.pop()!;
    const dir = await this.resolveDir(parts.join('/'), false);
    const fh = await dir.getFileHandle(fileName);
    const file = await fh.getFile();
    const text = await file.text();
    const decoded = deserializeBlueprint(text);
    if (!decoded.ok) throw new Error(decoded.error);
    return { doc: decoded.doc, warnings: decoded.warnings };
  }

  async writeBlueprint(relPath: string, doc: BlueprintDocument): Promise<void> {
    const norm = normalizeRelPath(relPath);
    const parts = norm.split('/');
    const fileName = sanitizeFileName(parts.pop()!);
    const dir = await this.resolveDir(parts.join('/'), true);
    const fh = await dir.getFileHandle(fileName, { create: true });
    const writable = await fh.createWritable();
    await writable.write(serializeBlueprint(doc));
    await writable.close();
  }

  async createFolder(relPath: string): Promise<void> {
    await this.resolveDir(relPath, true);
  }

  async deleteEntry(relPath: string): Promise<void> {
    const norm = normalizeRelPath(relPath);
    const parts = norm.split('/');
    const name = parts.pop()!;
    const dir = await this.resolveDir(parts.join('/'), false);
    await dir.removeEntry(name, { recursive: true });
  }

  async moveEntry(fromPath: string, toPath: string): Promise<void> {
    const normFrom = normalizeRelPath(fromPath);
    const normTo = normalizeRelPath(toPath);
    if (normFrom === normTo) return;
    // File move: read -> write -> delete
    const { doc } = await this.readBlueprint(normFrom);
    await this.writeBlueprint(normTo, doc);
    await this.deleteEntry(normFrom);
  }
}

interface VirtualStoreData {
  /** User-created empty folders (built-in preset folders are derived dynamically in memory) */
  folders: string[];
  /** Copy-on-write user overrides & newly created blueprints ONLY (unmodified built-in presets consume 0 bytes in localStorage!) */
  files: Record<string, { raw: string; updatedAt: number }>;
  /** Built-in preset paths explicitly deleted or moved away by the user */
  deletedPresets?: string[];
  seededPresetPaths?: string[];
  presetRevision?: number;
  storageMode?: 'overlay-v3';
}

const VIRTUAL_LIB_KEY = 'ms-sbd:virtual-library:v2';
const CURRENT_PRESET_REVISION = 12;
const SUPERSEDED_PRESET_PATHS = [
  '星穹总线超市/标准生产细胞/Cell-7S-超算9台满铺舱.json',
  '星穹总线超市/标准枢纽/B1-中央7x8井字立交.json',
];

/**
 * Built-in Offline Virtual Folder Driver (Copy-on-Write Overlay over in-memory built-in presets).
 * Built-in presets (including 26k+ building full-belts blueprints) are served directly from memory
 * with 0 bytes stored in localStorage, preventing browser 5 MB QuotaExceededError forever.
 */
export class VirtualFolderDriver implements BlueprintLibraryDriver {
  readonly mode = 'virtual-idb' as const;
  readonly rootLabel = '本地蓝图库（内置）';

  private migrateAndClean(store: VirtualStoreData): boolean {
    const builtins = getBuiltinPresetMap();
    const needsUpgrade = store.storageMode !== 'overlay-v3' || (store.presetRevision ?? 0) < CURRENT_PRESET_REVISION;
    let changed = needsUpgrade;

    if (!Array.isArray(store.deletedPresets)) {
      store.deletedPresets = [];
      changed = true;
    }

    if (needsUpgrade) {
      // Remove superseded preset paths
      for (const obsolete of SUPERSEDED_PRESET_PATHS) {
        const normOld = normalizeRelPath(obsolete);
        if (store.files[normOld]) {
          delete store.files[normOld];
          changed = true;
        }
      }
      // Strip legacy seeded copies of built-in presets out of localStorage!
      // Previously every built-in preset was duplicated into store.files with 2-space indent (~9+ MB),
      // causing QuotaExceededError. Now built-in presets live in memory with 0 localStorage footprint.
      for (const key of Object.keys(store.files)) {
        const norm = normalizeRelPath(key);
        if (builtins.has(norm)) {
          delete store.files[key];
          changed = true;
        }
      }
      // Re-compact any remaining user-authored blueprints to save space
      for (const rec of Object.values(store.files)) {
        const decoded = deserializeBlueprint(rec.raw);
        if (decoded.ok) {
          const compact = serializeCompact(decoded.doc);
          if (compact.length < rec.raw.length) {
            rec.raw = compact;
            changed = true;
          }
        }
      }
      // Clean obsolete seededPresetPaths list
      if (store.seededPresetPaths) {
        delete store.seededPresetPaths;
        changed = true;
      }
      store.presetRevision = CURRENT_PRESET_REVISION;
      store.storageMode = 'overlay-v3';
    }

    return changed;
  }

  private loadStore(): VirtualStoreData {
    try {
      const raw = localStorage.getItem(VIRTUAL_LIB_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as VirtualStoreData;
        if (parsed && Array.isArray(parsed.folders) && parsed.files && typeof parsed.files === 'object') {
          if (this.migrateAndClean(parsed)) {
            this.saveStore(parsed);
          }
          return parsed;
        }
      }
    } catch {
      // Fall through to clean overlay store
    }
    const fresh: VirtualStoreData = {
      folders: [],
      files: {},
      deletedPresets: [],
      presetRevision: CURRENT_PRESET_REVISION,
      storageMode: 'overlay-v3',
    };
    this.saveStore(fresh);
    return fresh;
  }

  private saveStore(store: VirtualStoreData): void {
    localStorage.setItem(VIRTUAL_LIB_KEY, JSON.stringify(store));
  }

  async listTree(): Promise<LibraryNode[]> {
    const store = this.loadStore();
    const builtins = getBuiltinPresetMap();
    const deleted = new Set((store.deletedPresets ?? []).map(normalizeRelPath));
    const rootChildren: LibraryNode[] = [];
    const folderMap = new Map<string, LibraryFolderEntry>();

    const ensureFolder = (folderPath: string): LibraryFolderEntry => {
      const norm = normalizeRelPath(folderPath);
      const existing = folderMap.get(norm);
      if (existing) return existing;
      const parts = norm.split('/');
      const name = parts[parts.length - 1];
      const entry: LibraryFolderEntry = { kind: 'folder', path: norm, name, children: [] };
      folderMap.set(norm, entry);
      if (parts.length === 1) {
        rootChildren.push(entry);
      } else {
        const parent = ensureFolder(parts.slice(0, -1).join('/'));
        parent.children.push(entry);
      }
      return entry;
    };

    const addFileNode = (norm: string, doc: BlueprintDocument, updatedAt: number) => {
      const fileNode = summarizeDoc(norm, doc, updatedAt);
      const parts = norm.split('/');
      if (parts.length === 1) {
        rootChildren.push(fileNode);
      } else {
        const parent = ensureFolder(parts.slice(0, -1).join('/'));
        parent.children.push(fileNode);
      }
    };

    for (const f of store.folders) {
      if (normalizeRelPath(f)) ensureFolder(f);
    }

    const emittedPaths = new Set<string>();

    // 1) User overrides and custom blueprints from overlay store
    for (const [rel, rec] of Object.entries(store.files)) {
      const norm = normalizeRelPath(rel);
      const decoded = deserializeBlueprint(rec.raw);
      if (!decoded.ok) continue;
      emittedPaths.add(norm);
      addFileNode(norm, decoded.doc, rec.updatedAt);
    }

    // 2) Unmodified built-in presets directly from memory (0 localStorage bytes!)
    for (const [norm, doc] of builtins.entries()) {
      if (emittedPaths.has(norm) || deleted.has(norm)) continue;
      addFileNode(norm, doc, 0);
    }

    return sortNodes(rootChildren);
  }

  async readBlueprint(relPath: string): Promise<{ doc: BlueprintDocument; warnings: string[] }> {
    const store = this.loadStore();
    const norm = normalizeRelPath(relPath);
    const rec = store.files[norm];
    if (rec) {
      const decoded = deserializeBlueprint(rec.raw);
      if (!decoded.ok) throw new Error(decoded.error);
      return { doc: decoded.doc, warnings: decoded.warnings };
    }
    const deleted = new Set((store.deletedPresets ?? []).map(normalizeRelPath));
    const builtin = !deleted.has(norm) ? getBuiltinPresetMap().get(norm) : undefined;
    if (builtin) {
      return { doc: cloneDoc(builtin), warnings: [] };
    }
    throw new Error(`未找到蓝图文件：${relPath}`);
  }

  async writeBlueprint(relPath: string, doc: BlueprintDocument): Promise<void> {
    const store = this.loadStore();
    const norm = normalizeRelPath(relPath);
    const parts = norm.split('/');
    const fileName = sanitizeFileName(parts.pop()!);
    const finalPath = parts.length > 0 ? `${parts.join('/')}/${fileName}` : fileName;
    if (parts.length > 0) {
      const folderPath = parts.join('/');
      if (!store.folders.includes(folderPath)) store.folders.push(folderPath);
    }
    if (store.deletedPresets) {
      store.deletedPresets = store.deletedPresets.filter((p) => normalizeRelPath(p) !== finalPath);
    }
    store.files[finalPath] = { raw: serializeCompact(doc), updatedAt: Date.now() };
    this.saveStore(store);
  }

  async createFolder(relPath: string): Promise<void> {
    const store = this.loadStore();
    const norm = normalizeRelPath(relPath);
    if (norm && !store.folders.includes(norm)) {
      store.folders.push(norm);
      this.saveStore(store);
    }
  }

  async deleteEntry(relPath: string): Promise<void> {
    const store = this.loadStore();
    const norm = normalizeRelPath(relPath);
    delete store.files[norm];
    store.folders = store.folders.filter((f) => f !== norm && !f.startsWith(`${norm}/`));
    for (const key of Object.keys(store.files)) {
      if (key.startsWith(`${norm}/`)) delete store.files[key];
    }
    const deleted = new Set((store.deletedPresets ?? []).map(normalizeRelPath));
    for (const builtinPath of getBuiltinPresetMap().keys()) {
      if (builtinPath === norm || builtinPath.startsWith(`${norm}/`)) {
        deleted.add(builtinPath);
      }
    }
    store.deletedPresets = [...deleted];
    this.saveStore(store);
  }

  async moveEntry(fromPath: string, toPath: string): Promise<void> {
    const store = this.loadStore();
    const normFrom = normalizeRelPath(fromPath);
    const normTo = normalizeRelPath(toPath);
    if (normFrom === normTo) return;
    if (store.files[normFrom]) {
      store.files[normTo] = store.files[normFrom];
      delete store.files[normFrom];
    } else {
      const builtin = getBuiltinPresetMap().get(normFrom);
      if (!builtin) return;
      store.files[normTo] = { raw: serializeCompact(builtin), updatedAt: Date.now() };
      const deleted = new Set((store.deletedPresets ?? []).map(normalizeRelPath));
      deleted.add(normFrom);
      store.deletedPresets = [...deleted];
    }
    const parts = normTo.split('/');
    if (parts.length > 1) {
      const folder = parts.slice(0, -1).join('/');
      if (!store.folders.includes(folder)) store.folders.push(folder);
    }
    if (store.deletedPresets) {
      store.deletedPresets = store.deletedPresets.filter((p) => normalizeRelPath(p) !== normTo);
    }
    this.saveStore(store);
  }
}
