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

export function saveWorkspaceAutosave(doc: BlueprintDocument, sourcePath: string | null, dirty = false): number {
  const savedAt = Date.now();
  const payload = JSON.stringify({
    savedAt,
    sourcePath,
    dirty,
    presetRevision: CURRENT_PRESET_REVISION,
    raw: serializeBlueprint(doc),
  });
  localStorage.setItem(AUTOSAVE_KEY, payload);
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
      raw?: string;
    };
    if (!parsed || typeof parsed.raw !== 'string') return null;
    const sourcePath = typeof parsed.sourcePath === 'string' ? parsed.sourcePath : null;
    // If an unmodified built-in preset was open in the previous session and built-in presets upgraded,
    // automatically load the freshly updated preset instead of showing stale pre-fix cached geometry!
    if (sourcePath && !parsed.dirty && (parsed.presetRevision ?? 0) < CURRENT_PRESET_REVISION) {
      const norm = normalizeRelPath(sourcePath);
      const freshPreset = DEFAULT_LIBRARY_PRESETS.find((p) => normalizeRelPath(p.path) === norm);
      if (freshPreset) {
        return {
          savedAt: Date.now(),
          sourcePath,
          dirty: false,
          presetRevision: CURRENT_PRESET_REVISION,
          doc: freshPreset.doc,
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
  folders: string[];
  files: Record<string, { raw: string; updatedAt: number }>;
  seededPresetPaths?: string[];
  presetRevision?: number;
}

const VIRTUAL_LIB_KEY = 'ms-sbd:virtual-library:v2';
const CURRENT_PRESET_REVISION = 7;
const SUPERSEDED_PRESET_PATHS = [
  '星穹总线超市/标准生产细胞/Cell-7S-超算9台满铺舱.json',
  '星穹总线超市/标准枢纽/B1-中央7x8井字立交.json',
];

function ensureParentFolders(folders: string[], relPath: string): void {
  const parts = normalizeRelPath(relPath).split('/');
  parts.pop();
  let cur = '';
  for (const seg of parts) {
    cur = cur ? `${cur}/${seg}` : seg;
    if (!folders.includes(cur)) folders.push(cur);
  }
}

/**
 * Built-in Offline Virtual Folder Driver (persisted in localStorage/IndexedDB)
 * Used before the user mounts a real OS folder or on browsers without File System Access API.
 */
export class VirtualFolderDriver implements BlueprintLibraryDriver {
  readonly mode = 'virtual-idb' as const;
  readonly rootLabel = '本地蓝图库（内置）';

  private syncNewPresets(store: VirtualStoreData): boolean {
    const seeded = new Set(store.seededPresetPaths ?? []);
    const needsRevisionRefresh = (store.presetRevision ?? 0) < CURRENT_PRESET_REVISION;
    let changed = !Array.isArray(store.seededPresetPaths) || needsRevisionRefresh;
    const now = Date.now();
    if (needsRevisionRefresh) {
      for (const obsolete of SUPERSEDED_PRESET_PATHS) {
        const normOld = normalizeRelPath(obsolete);
        if (store.files[normOld]) {
          delete store.files[normOld];
          changed = true;
        }
      }
    }
    for (const preset of DEFAULT_LIBRARY_PRESETS) {
      const norm = normalizeRelPath(preset.path);
      if (!needsRevisionRefresh && seeded.has(norm)) continue;
      seeded.add(norm);
      if (needsRevisionRefresh || !store.files[norm]) {
        ensureParentFolders(store.folders, norm);
        store.files[norm] = { raw: serializeBlueprint(preset.doc), updatedAt: now };
      }
      changed = true;
    }
    store.seededPresetPaths = [...seeded];
    store.presetRevision = CURRENT_PRESET_REVISION;
    return changed;
  }

  private loadStore(): VirtualStoreData {
    try {
      const raw = localStorage.getItem(VIRTUAL_LIB_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as VirtualStoreData;
        if (parsed && Array.isArray(parsed.folders) && parsed.files && typeof parsed.files === 'object') {
          if (this.syncNewPresets(parsed)) {
            this.saveStore(parsed);
          }
          return parsed;
        }
      }
    } catch {
      // Fall through to seed
    }
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
    const seeded: VirtualStoreData = {
      folders: ['整站方案', '产线子蓝图'],
      files: {
        '整站方案/双层装配枢纽.json': { raw: serializeBlueprint(starter), updatedAt: Date.now() },
        '产线子蓝图/双精炼标准单元.json': { raw: serializeBlueprint(subLine), updatedAt: Date.now() },
      },
      seededPresetPaths: [],
    };
    this.syncNewPresets(seeded);
    this.saveStore(seeded);
    return seeded;
  }

  private saveStore(store: VirtualStoreData): void {
    localStorage.setItem(VIRTUAL_LIB_KEY, JSON.stringify(store));
  }

  async listTree(): Promise<LibraryNode[]> {
    const store = this.loadStore();
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

    for (const f of store.folders) {
      if (normalizeRelPath(f)) ensureFolder(f);
    }

    for (const [rel, rec] of Object.entries(store.files)) {
      const norm = normalizeRelPath(rel);
      const decoded = deserializeBlueprint(rec.raw);
      if (!decoded.ok) continue;
      const fileNode = summarizeDoc(norm, decoded.doc, rec.updatedAt);
      const parts = norm.split('/');
      if (parts.length === 1) {
        rootChildren.push(fileNode);
      } else {
        const parent = ensureFolder(parts.slice(0, -1).join('/'));
        parent.children.push(fileNode);
      }
    }

    return sortNodes(rootChildren);
  }

  async readBlueprint(relPath: string): Promise<{ doc: BlueprintDocument; warnings: string[] }> {
    const store = this.loadStore();
    const rec = store.files[normalizeRelPath(relPath)];
    if (!rec) throw new Error(`未找到蓝图文件：${relPath}`);
    const decoded = deserializeBlueprint(rec.raw);
    if (!decoded.ok) throw new Error(decoded.error);
    return { doc: decoded.doc, warnings: decoded.warnings };
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
    store.files[finalPath] = { raw: serializeBlueprint(doc), updatedAt: Date.now() };
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
      const parts = normTo.split('/');
      if (parts.length > 1) {
        const folder = parts.slice(0, -1).join('/');
        if (!store.folders.includes(folder)) store.folders.push(folder);
      }
      this.saveStore(store);
    }
  }
}
