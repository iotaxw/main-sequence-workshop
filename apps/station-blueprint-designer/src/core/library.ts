import { deserializeBlueprint, serializeBlueprint } from './codec';
import { getDocumentFloorRange } from './geometry';
import { DEFAULT_LIBRARY_PRESETS } from './presets';
import type { BlueprintDocument, LibraryFileEntry, LibraryFolderEntry, LibraryNode } from './types';

export interface BlueprintLibraryDriver {
  readonly mode: 'fs-local' | 'virtual-idb' | 'github-private';
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
const CURRENT_PRESET_REVISION = 13;
const SUPERSEDED_PRESET_PATHS = [
  '星穹总线超市/标准生产细胞/Cell-7S-超算9台满铺舱.json',
  '星穹总线超市/标准枢纽/B1-中央7x8井字立交.json',
  '整站方案/双层装配枢纽.json',
  '产线子蓝图/双精炼标准单元.json',
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

/* ================================================================
   GitHub Private Repository Driver (Client-Side Direct API Sync)
   Allows accessing & syncing private blueprints from ANY browser/device
   right inside the public GitHub Pages app, with zero backend & zero paywall!
   ================================================================ */

const GITHUB_CONFIG_KEY = 'ms-sbd:github-private-repo:v1';

export interface GitHubRepoConfig {
  owner: string;
  repo: string;
  branch: string;
  /** Optional subfolder inside the repo, e.g. "" (root) or "blueprints" */
  basePath: string;
  /** Fine-grained PAT scoped strictly to this private repo's Contents (Read & Write); stored ONLY in local browser storage */
  token: string;
}

export function loadSavedGitHubConfig(): GitHubRepoConfig | null {
  try {
    const raw = localStorage.getItem(GITHUB_CONFIG_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<GitHubRepoConfig>;
    if (!p || typeof p.owner !== 'string' || typeof p.repo !== 'string' || typeof p.token !== 'string') {
      return null;
    }
    const owner = p.owner.trim();
    const repo = p.repo.trim();
    const token = p.token.trim();
    if (!owner || !repo || !token) return null;
    return {
      owner,
      repo,
      branch: typeof p.branch === 'string' && p.branch.trim() ? p.branch.trim() : 'main',
      basePath: typeof p.basePath === 'string' ? normalizeRelPath(p.basePath) : '',
      token,
    };
  } catch {
    return null;
  }
}

export function saveGitHubConfig(cfg: GitHubRepoConfig): void {
  localStorage.setItem(
    GITHUB_CONFIG_KEY,
    JSON.stringify({
      owner: cfg.owner.trim(),
      repo: cfg.repo.trim(),
      branch: cfg.branch.trim() || 'main',
      basePath: normalizeRelPath(cfg.basePath),
      token: cfg.token.trim(),
    })
  );
}

export function clearSavedGitHubConfig(): void {
  try {
    localStorage.removeItem(GITHUB_CONFIG_KEY);
  } catch {
    // ignore
  }
}

function encodeGitHubPath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function base64ToUtf8(b64: string): string {
  const clean = b64.replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

export class GitHubPrivateRepoDriver implements BlueprintLibraryDriver {
  readonly mode = 'github-private' as const;
  readonly rootLabel: string;
  readonly config: GitHubRepoConfig;
  private shaByRelPath = new Map<string, string>();
  private metaByRelPath = new Map<string, { blueprintName: string; moduleCount: number; buildingCount: number; floorSpan: number }>();

  constructor(config: GitHubRepoConfig) {
    this.config = {
      owner: config.owner.trim(),
      repo: config.repo.trim(),
      branch: config.branch.trim() || 'main',
      basePath: normalizeRelPath(config.basePath),
      token: config.token.trim(),
    };
    const sub = this.config.basePath ? `/${this.config.basePath}` : '';
    this.rootLabel = `GitHub 私有库 · ${this.config.owner}/${this.config.repo}${sub}`;
  }

  private fullRepoPath(relPath: string): string {
    const norm = normalizeRelPath(relPath);
    if (!this.config.basePath) return norm;
    return norm ? `${this.config.basePath}/${norm}` : this.config.basePath;
  }

  private async apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const resp = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.config.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (!resp.ok) {
      let detail = `HTTP ${resp.status}`;
      try {
        const errJson = (await resp.json()) as { message?: string };
        if (errJson?.message) detail = `${detail}: ${errJson.message}`;
      } catch {
        // ignore body parse failure
      }
      throw new Error(`GitHub 私有库请求失败 (${detail})`);
    }
    return (await resp.json()) as T;
  }

  async listTree(): Promise<LibraryNode[]> {
    const { owner, repo, branch, basePath } = this.config;
    const treeResp = await this.apiRequest<{
      tree?: Array<{ path: string; type: string; sha: string }>;
      truncated?: boolean;
    }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`);

    this.shaByRelPath.clear();
    const prefix = basePath ? `${basePath}/` : '';
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
        ensureFolder(parts.slice(0, -1).join('/')).children.push(entry);
      }
      return entry;
    };

    for (const item of treeResp.tree ?? []) {
      if (prefix && !item.path.startsWith(prefix)) continue;
      const rel = prefix ? item.path.slice(prefix.length) : item.path;
      if (!rel) continue;

      if (item.type === 'tree') {
        ensureFolder(rel);
        continue;
      }
      if (item.type !== 'blob') continue;
      if (!rel.toLowerCase().endsWith('.json')) {
        if (rel.endsWith('/.gitkeep')) {
          const dir = rel.slice(0, -'/.gitkeep'.length);
          if (dir) ensureFolder(dir);
        }
        continue;
      }

      const norm = normalizeRelPath(rel);
      this.shaByRelPath.set(norm, item.sha);
      const segs = norm.split('/');
      const fileName = segs[segs.length - 1];
      const cached = this.metaByRelPath.get(norm);
      const fileNode: LibraryFileEntry = {
        kind: 'file',
        path: norm,
        name: fileName.replace(/\.json$/i, ''),
        fileName,
        blueprintName: cached?.blueprintName ?? fileName.replace(/\.json$/i, ''),
        moduleCount: cached?.moduleCount ?? 0,
        buildingCount: cached?.buildingCount ?? 0,
        floorSpan: cached?.floorSpan ?? 1,
        updatedAt: 0,
      };
      if (segs.length === 1) {
        rootChildren.push(fileNode);
      } else {
        ensureFolder(segs.slice(0, -1).join('/')).children.push(fileNode);
      }
    }

    return sortNodes(rootChildren);
  }

  async readBlueprint(relPath: string): Promise<{ doc: BlueprintDocument; warnings: string[] }> {
    const { owner, repo, branch } = this.config;
    const norm = normalizeRelPath(relPath);
    let sha = this.shaByRelPath.get(norm);

    let text: string;
    if (sha) {
      // Use Git Blobs API so large mega-station blueprints (>1 MB, up to 100 MB) load cleanly!
      const blob = await this.apiRequest<{ content: string; encoding: string }>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(sha)}`
      );
      text = blob.encoding === 'base64' ? base64ToUtf8(blob.content) : blob.content;
    } else {
      const full = encodeGitHubPath(this.fullRepoPath(norm));
      const fileResp = await this.apiRequest<{ sha: string; content?: string; encoding?: string }>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${full}?ref=${encodeURIComponent(branch)}`
      );
      sha = fileResp.sha;
      this.shaByRelPath.set(norm, sha);
      if (fileResp.content) {
        text = fileResp.encoding === 'base64' ? base64ToUtf8(fileResp.content) : fileResp.content;
      } else {
        const blob = await this.apiRequest<{ content: string; encoding: string }>(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(sha)}`
        );
        text = blob.encoding === 'base64' ? base64ToUtf8(blob.content) : blob.content;
      }
    }

    const decoded = deserializeBlueprint(text);
    if (!decoded.ok) throw new Error(decoded.error);
    const range = getDocumentFloorRange(decoded.doc);
    this.metaByRelPath.set(norm, {
      blueprintName: decoded.doc.name,
      moduleCount: decoded.doc.modules.length,
      buildingCount: decoded.doc.buildings.length,
      floorSpan: Math.max(1, range.max - range.min + 1),
    });
    return { doc: decoded.doc, warnings: decoded.warnings };
  }

  async writeBlueprint(relPath: string, doc: BlueprintDocument): Promise<void> {
    const { owner, repo, branch } = this.config;
    const norm = normalizeRelPath(relPath);
    const parts = norm.split('/');
    const fileName = sanitizeFileName(parts.pop()!);
    const finalRel = parts.length > 0 ? `${parts.join('/')}/${fileName}` : fileName;
    const full = encodeGitHubPath(this.fullRepoPath(finalRel));

    const existingSha = this.shaByRelPath.get(finalRel);
    const body: Record<string, unknown> = {
      message: `chore(blueprints): save ${finalRel}`,
      content: utf8ToBase64(serializeBlueprint(doc)),
      branch,
      ...(existingSha ? { sha: existingSha } : {}),
    };

    const res = await this.apiRequest<{ content?: { sha?: string } }>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${full}`,
      { method: 'PUT', body: JSON.stringify(body) }
    );
    if (res.content?.sha) {
      this.shaByRelPath.set(finalRel, res.content.sha);
    }
    const range = getDocumentFloorRange(doc);
    this.metaByRelPath.set(finalRel, {
      blueprintName: doc.name,
      moduleCount: doc.modules.length,
      buildingCount: doc.buildings.length,
      floorSpan: Math.max(1, range.max - range.min + 1),
    });
  }

  async createFolder(relPath: string): Promise<void> {
    const { owner, repo, branch } = this.config;
    const norm = normalizeRelPath(relPath);
    if (!norm) return;
    const full = encodeGitHubPath(this.fullRepoPath(`${norm}/.gitkeep`));
    await this.apiRequest(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${full}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          message: `chore(blueprints): create folder ${norm}`,
          content: '',
          branch,
        }),
      }
    );
  }

  async deleteEntry(relPath: string): Promise<void> {
    const { owner, repo, branch } = this.config;
    const norm = normalizeRelPath(relPath);
    const targets: Array<[string, string]> = [];
    for (const [k, sha] of this.shaByRelPath.entries()) {
      if (k === norm || k.startsWith(`${norm}/`)) {
        targets.push([k, sha]);
      }
    }
    for (const [pathKey, sha] of targets) {
      const full = encodeGitHubPath(this.fullRepoPath(pathKey));
      await this.apiRequest(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${full}`,
        {
          method: 'DELETE',
          body: JSON.stringify({
            message: `chore(blueprints): delete ${pathKey}`,
            sha,
            branch,
          }),
        }
      );
      this.shaByRelPath.delete(pathKey);
      this.metaByRelPath.delete(pathKey);
    }
  }

  async moveEntry(fromPath: string, toPath: string): Promise<void> {
    const { doc } = await this.readBlueprint(fromPath);
    await this.writeBlueprint(toPath, doc);
    await this.deleteEntry(fromPath);
  }
}
