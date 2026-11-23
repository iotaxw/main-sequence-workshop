import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildPlannedBeltPath, cellsToBeltSpecs, extendBeltStroke, selectConnectedBeltChain } from './core/belt-router';
import { getBuildableDef, getModuleDef, getRecipeDef } from './core/catalog';
import { createStarterBlueprint, deserializeBlueprint, serializeBlueprint } from './core/codec';
import { cycleVariantInGroup, findGroupForEntity, getGroupsForView, getShortLabel } from './core/groups';
import {
  boxSelectEntities,
  commitHistory,
  createEmptyBlueprint,
  createHistory,
  deleteSelectionCmd,
  extractSelectionAsBlueprint,
  mirrorBlueprintX,
  placeBeltRunCmd,
  placeBuildingCmd,
  placeModuleCmd,
  redoHistory,
  rotateBlueprint,
  rotateSelectionInPlaceCmd,
  stampBlueprintCmd,
  undoHistory,
  updateBuildingConfigCmd,
  updateModuleLabelCmd,
} from './core/commands';
import {
  findBuildingAtCell,
  findBuildingsInsideModule,
  findModuleAtWorldPoint,
  getBuildingSizeCells,
  getModuleBoundsM,
  getToggleablePorts,
  normalizeRotation,
  STATION_UNIT_M,
} from './core/geometry';
import {
  BlueprintLibraryDriver,
  FileSystemFolderDriver,
  loadWorkspaceAutosave,
  normalizeRelPath,
  sanitizeFileName,
  saveWorkspaceAutosave,
  VirtualFolderDriver,
} from './core/library';
import { simulateBlueprint, type SimulationIssue } from './core/simulation';
import type {
  ActiveTool,
  BlueprintDocument,
  LibraryFileEntry,
  LibraryNode,
  Rotation,
  SelectionLayerMode,
  SelectionState,
  ViewMode,
} from './core/types';
import { PITCH_SNAP_PRESETS } from './renderer/camera-rig';
import { CadSceneController } from './renderer/scene-controller';
import { CAD_THEMES, type CadThemeId, loadSavedTheme, saveTheme } from './renderer/theme';
import { HelpDrawer } from './ui/HelpDrawer';
import { InspectorPanel } from './ui/InspectorPanel';
import { LibrarySidebar } from './ui/LibrarySidebar';
import { PaletteDock } from './ui/PaletteDock';
import { SimulationPanel } from './ui/SimulationPanel';

const EMPTY_SELECTION: SelectionState = { moduleIds: [], buildingIds: [] };

function isTextInputFocused(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function collectFolderPaths(nodes: LibraryNode[]): string[] {
  const out: string[] = [''];
  const walk = (list: LibraryNode[]) => {
    for (const n of list) {
      if (n.kind === 'folder') {
        out.push(n.path);
        walk(n.children);
      }
    }
  };
  walk(nodes);
  return out;
}

export const App: React.FC = () => {
  const initialSession = useMemo(() => {
    const recovered = loadWorkspaceAutosave();
    if (recovered) return recovered;
    return { savedAt: 0, sourcePath: '整站方案/双层装配枢纽.json', doc: createStarterBlueprint() };
  }, []);

  const [history, setHistory] = useState(() => createHistory(initialSession.doc));
  const doc = history.present;
  const [activeSourcePath, setActiveSourcePath] = useState<string | null>(initialSession.sourcePath);
  const [dirty, setDirty] = useState(false);
  const [lastAutosaveAt, setLastAutosaveAt] = useState<number | null>(initialSession.savedAt || null);

  const [viewMode, setViewMode] = useState<ViewMode>('station');
  const [theme, setTheme] = useState<CadThemeId>(() => loadSavedTheme());
  const [focusFloor, setFocusFloor] = useState(0);
  const [hideAbove, setHideAbove] = useState(true);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [selectionLayerMode, setSelectionLayerMode] = useState<SelectionLayerMode>('focus');
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION);
  const [activeTool, setActiveTool] = useState<ActiveTool>({ kind: 'select' });
  const [lastGroupMember, setLastGroupMember] = useState<Record<string, string>>({});
  const [stampingLibPath, setStampingLibPath] = useState<string | null>(null);
  const [clipboardBp, setClipboardBp] = useState<BlueprintDocument | null>(null);

  const [libraryOpen, setLibraryOpen] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);
  const [simOpen, setSimOpen] = useState(false);
  const [driver, setDriver] = useState<BlueprintLibraryDriver>(() => new VirtualFolderDriver());
  const [libraryTree, setLibraryTree] = useState<LibraryNode[]>([]);

  const simReport = useMemo(() => (simOpen ? simulateBlueprint(doc) : null), [doc, simOpen]);
  const simOverlayIssues = useMemo(
    () =>
      simReport
        ? simReport.issues.map((i) => ({ floor: i.floor, x: i.x, y: i.y, severity: i.severity, code: i.code }))
        : undefined,
    [simReport]
  );

  const [cursorWorld, setCursorWorld] = useState<{ x: number; y: number } | null>(null);
  const [beltPreview, setBeltPreview] = useState<Array<{ x: number; y: number; rotation: Rotation }>>([]);
  const [boxSelectRect, setBoxSelectRect] = useState<{ minX: number; minY: number; maxX: number; maxY: number } | null>(null);
  const [forceReplaceHeld, setForceReplaceHeld] = useState(false);
  const [telemetry, setTelemetry] = useState({ yawDeg: 0, pitchDeg: 64, distance: 76 });
  const [toast, setToast] = useState<{ text: string; kind: 'info' | 'warn' | 'error' } | null>(null);

  const [saveDialog, setSaveDialog] = useState<{
    mode: 'workspace' | 'selection';
    docToSave: BlueprintDocument;
    folder: string;
    name: string;
  } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    selection: SelectionState;
    moduleCount: number;
    insideBuildingCount: number;
  } | null>(null);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<CadSceneController | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const stateRef = useRef({
    doc,
    viewMode,
    focusFloor,
    hideAbove,
    selection,
    selectionLayerMode,
    activeTool,
    lastGroupMember,
    clipboardBp,
  });
  stateRef.current = {
    doc,
    viewMode,
    focusFloor,
    hideAbove,
    selection,
    selectionLayerMode,
    activeTool,
    lastGroupMember,
    clipboardBp,
  };

  const dragRef = useRef<{
    kind: 'none' | 'orbit' | 'pan' | 'box-select' | 'belt-stroke' | 'belt-plan' | 'demolish';
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    moved: boolean;
    startWorld: { x: number; y: number } | null;
    beltCells: Array<[number, number]>;
    beltFlipCorner: boolean;
    beltReverse: boolean;
    boxModifier: 'replace' | 'add' | 'sub';
  }>({
    kind: 'none',
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    moved: false,
    startWorld: null,
    beltCells: [],
    beltFlipCorner: false,
    beltReverse: false,
    boxModifier: 'replace',
  });

  const spaceHeldRef = useRef(false);

  const showToast = useCallback((text: string, kind: 'info' | 'warn' | 'error' = 'info') => {
    setToast({ text, kind });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  const commitDoc = useCallback((next: BlueprintDocument) => {
    setHistory((h) => commitHistory(h, next));
    setDirty(true);
  }, []);

  const refreshLibrary = useCallback(
    async (targetDriver?: BlueprintLibraryDriver) => {
      const drv = targetDriver ?? driver;
      try {
        const nodes = await drv.listTree();
        setLibraryTree(nodes);
      } catch (err) {
        showToast(`读取目录失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },
    [driver, showToast]
  );

  useEffect(() => {
    void refreshLibrary(driver);
  }, [driver, refreshLibrary]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const ts = saveWorkspaceAutosave(doc, activeSourcePath, dirty);
        setLastAutosaveAt(ts);
      } catch {
        // Ignore storage quota errors without claiming file saved
      }
    }, 450);
    return () => window.clearTimeout(timer);
  }, [doc, activeSourcePath, dirty]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ctrl = new CadSceneController(el, {
      onAutoViewModeChange: (nextMode) => {
        setViewMode(nextMode);
        setActiveTool((prev) => {
          if (nextMode === 'station' && prev.kind === 'place-building') return { kind: 'select' };
          if (nextMode === 'building' && prev.kind === 'place-module') return { kind: 'select' };
          return prev;
        });
      },
      onTelemetryChange: (info) => setTelemetry(info),
    });
    sceneRef.current = ctrl;

    const ro = new ResizeObserver(() => ctrl.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      ctrl.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    document.documentElement.style.colorScheme = theme === 'stealth-cad' ? 'only light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    sceneRef.current?.syncState({
      doc,
      theme,
      viewMode,
      focusFloor,
      hideAbove,
      selection,
      selectionLayerMode,
      activeTool,
      cursorWorld,
      beltPreview,
      boxSelectRect,
      forceReplaceHeld,
      simulationIssues: simOverlayIssues,
    });
  }, [
    doc,
    theme,
    viewMode,
    focusFloor,
    hideAbove,
    selection,
    selectionLayerMode,
    activeTool,
    cursorWorld,
    beltPreview,
    boxSelectRect,
    forceReplaceHeld,
    simOverlayIssues,
  ]);

  const switchViewMode = useCallback((nextMode: ViewMode, focusCenter?: [number, number]) => {
    setViewMode(nextMode);
    sceneRef.current?.rig.setViewMode(nextMode, true);
    if (focusCenter) {
      sceneRef.current?.rig.focusPoint(focusCenter[0], focusCenter[1]);
    }
    setActiveTool((prev) => {
      if (nextMode === 'station' && prev.kind === 'place-building') return { kind: 'select' };
      if (nextMode === 'building' && prev.kind === 'place-module') return { kind: 'select' };
      return prev;
    });
  }, []);

  const fitAllStation = useCallback(() => {
    const rig = sceneRef.current?.rig;
    if (!rig) return;
    const curDoc = stateRef.current.doc;
    if (curDoc.modules.length === 0) {
      rig.focusPoint(16, 16, 76);
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const m of curDoc.modules) {
      const def = getModuleDef(m.type);
      if (!def) continue;
      const [x0, y0, x1, y1] = getModuleBoundsM(m, def);
      minX = Math.min(minX, x0);
      minY = Math.min(minY, y0);
      maxX = Math.max(maxX, x1);
      maxY = Math.max(maxY, y1);
    }
    rig.fitBounds(minX, minY, maxX, maxY);
  }, []);

  const focusSelection = useCallback(() => {
    const rig = sceneRef.current?.rig;
    const { doc: curDoc, selection: sel } = stateRef.current;
    if (!rig) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const mid of sel.moduleIds) {
      const m = curDoc.modules.find((x) => x.id === mid);
      const def = m ? getModuleDef(m.type) : undefined;
      if (!m || !def) continue;
      const [x0, y0, x1, y1] = getModuleBoundsM(m, def);
      minX = Math.min(minX, x0);
      minY = Math.min(minY, y0);
      maxX = Math.max(maxX, x1);
      maxY = Math.max(maxY, y1);
    }
    for (const bid of sel.buildingIds) {
      const b = curDoc.buildings.find((x) => x.id === bid);
      const def = b ? getBuildableDef(b.type) : undefined;
      if (!b || !def) continue;
      const [w, d] = getBuildingSizeCells(def, b.rotation);
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + w);
      maxY = Math.max(maxY, b.y + d);
    }
    if (Number.isFinite(minX)) {
      rig.fitBounds(minX - 4, minY - 4, maxX + 4, maxY + 4);
    } else {
      fitAllStation();
    }
  }, [fitAllStation]);

  const requestDeleteSelection = useCallback(
    (sel: SelectionState) => {
      const curDoc = stateRef.current.doc;
      if (sel.moduleIds.length === 0 && sel.buildingIds.length === 0) return;

      let insideCount = 0;
      if (sel.moduleIds.length > 0) {
        const bldAlready = new Set(sel.buildingIds);
        for (const mid of sel.moduleIds) {
          const mod = curDoc.modules.find((m) => m.id === mid);
          if (!mod) continue;
          for (const inside of findBuildingsInsideModule(curDoc, mod)) {
            if (!bldAlready.has(inside.id)) {
              insideCount++;
              bldAlready.add(inside.id);
            }
          }
        }
      }

      if (insideCount > 0) {
        setDeleteConfirm({ selection: sel, moduleCount: sel.moduleIds.length, insideBuildingCount: insideCount });
        return;
      }

      const res = deleteSelectionCmd(curDoc, sel);
      if (res.changed) {
        commitDoc(res.doc);
        setSelection(EMPTY_SELECTION);
      }
    },
    [commitDoc]
  );

  const copySelectionToGhost = useCallback(
    (cut: boolean) => {
      const { doc: curDoc, selection: sel } = stateRef.current;
      const bp = extractSelectionAsBlueprint(curDoc, sel, '剪贴板蓝图');
      if (!bp) {
        showToast('请先选中模块或建筑再复制', 'warn');
        return;
      }
      setClipboardBp(bp);
      setStampingLibPath(null);
      setActiveTool({ kind: 'stamp-blueprint', blueprint: bp, name: bp.name, rotation: 0, floorOffset: 0 });
      if (cut) {
        const del = deleteSelectionCmd(curDoc, sel);
        if (del.changed) {
          commitDoc(del.doc);
          setSelection(EMPTY_SELECTION);
        }
        showToast('已剪切为幽灵蓝图（R旋转 / M镜像 / 左键盖章）');
      } else {
        showToast('已复制为幽灵蓝图（R旋转 / M镜像 / 左键盖章）');
      }
    },
    [commitDoc, showToast]
  );

  const openSaveDialog = useCallback(
    (preferSelection: boolean) => {
      const { doc: curDoc, selection: sel } = stateRef.current;
      const hasSel = sel.moduleIds.length > 0 || sel.buildingIds.length > 0;
      if (preferSelection && hasSel) {
        const sub = extractSelectionAsBlueprint(curDoc, sel, '新选区蓝图');
        if (sub) {
          setSaveDialog({
            mode: 'selection',
            docToSave: sub,
            folder: '产线子蓝图',
            name: sub.name,
          });
          return;
        }
      }
      const existingParts = activeSourcePath ? activeSourcePath.split('/') : [];
      const defaultName =
        curDoc.name ||
        (existingParts.length ? existingParts[existingParts.length - 1].replace(/\.json$/i, '') : '未命名空间站');
      const defaultFolder = existingParts.length > 1 ? existingParts.slice(0, -1).join('/') : '整站方案';
      setSaveDialog({
        mode: 'workspace',
        docToSave: curDoc,
        folder: defaultFolder,
        name: defaultName,
      });
    },
    [activeSourcePath]
  );

  const executeSaveDialog = useCallback(async () => {
    if (!saveDialog) return;
    const cleanName = saveDialog.name.trim() || '未命名蓝图';
    const fileName = sanitizeFileName(cleanName);
    const relPath = saveDialog.folder ? normalizeRelPath(`${saveDialog.folder}/${fileName}`) : fileName;
    const finalDoc: BlueprintDocument = { ...saveDialog.docToSave, name: cleanName };
    try {
      await driver.writeBlueprint(relPath, finalDoc);
      if (saveDialog.mode === 'workspace') {
        setHistory((h) => ({ ...h, present: finalDoc }));
        setActiveSourcePath(relPath);
        setDirty(false);
      }
      setSaveDialog(null);
      await refreshLibrary();
      showToast(`已保存到 ${relPath}`);
    } catch (err) {
      showToast(`保存失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }, [saveDialog, driver, refreshLibrary, showToast]);

  const selectEntityTool = useCallback(
    (
      entityId: string,
      opts?: {
        rotation?: Rotation;
        undergroundMode?: 'in' | 'out';
        recipeId?: string;
        label?: string;
        disabledPorts?: number[];
        priorityIn?: number;
        priorityOut?: number;
        portFilters?: Record<number, string>;
        filterItems?: string[];
      }
    ) => {
      setStampingLibPath(null);
      setBeltPreview([]);
      const modDef = getModuleDef(entityId);
      if (modDef) {
        const grp = findGroupForEntity('station', entityId);
        if (grp) setLastGroupMember((prev) => ({ ...prev, [grp.id]: entityId }));
        setActiveTool((prev) => ({
          kind: 'place-module',
          moduleType: entityId,
          rotation: opts?.rotation ?? (prev.kind === 'place-module' ? prev.rotation : 0),
          ...(opts?.label ? { label: opts.label } : {}),
        }));
        return;
      }
      const bldDef = getBuildableDef(entityId);
      if (bldDef) {
        const grp = findGroupForEntity('building', entityId);
        if (grp) setLastGroupMember((prev) => ({ ...prev, [grp.id]: entityId }));
        setActiveTool((prev) => ({
          kind: 'place-building',
          buildingType: entityId,
          rotation: opts?.rotation ?? (prev.kind === 'place-building' ? prev.rotation : 0),
          undergroundMode:
            bldDef.kind === 'underground'
              ? opts?.undergroundMode ?? (prev.kind === 'place-building' ? prev.undergroundMode : undefined) ?? 'in'
              : undefined,
          ...(opts?.recipeId ? { recipeId: opts.recipeId } : {}),
          ...(opts?.label ? { label: opts.label } : {}),
          ...(opts?.disabledPorts && opts.disabledPorts.length > 0
            ? { disabledPorts: [...opts.disabledPorts] }
            : {}),
          ...(opts?.priorityIn !== undefined ? { priorityIn: opts.priorityIn } : {}),
          ...(opts?.priorityOut !== undefined ? { priorityOut: opts.priorityOut } : {}),
          ...(opts?.portFilters && Object.keys(opts.portFilters).length > 0
            ? { portFilters: { ...opts.portFilters } }
            : {}),
          ...(opts?.filterItems && opts.filterItems.length > 0
            ? { filterItems: [...opts.filterItems] }
            : {}),
        }));
      }
    },
    []
  );

  const pipetteAtWorld = useCallback(
    (world: { x: number; y: number }) => {
      const { doc: curDoc, viewMode: vm, focusFloor: fl } = stateRef.current;
      if (vm === 'station') {
        const m = findModuleAtWorldPoint(curDoc, world.x, world.y, fl);
        if (!m) return;
        selectEntityTool(m.type, { rotation: m.rotation, label: m.label });
        const title = getShortLabel(m.type, getModuleDef(m.type)?.nameZh);
        showToast(m.label ? `吸管复制：${title} · ${m.label}` : `吸管复制：${title}`);
      } else {
        const b = findBuildingAtCell(curDoc, Math.floor(world.x), Math.floor(world.y), fl);
        if (!b) return;
        selectEntityTool(b.type, {
          rotation: b.rotation,
          undergroundMode: b.undergroundMode,
          recipeId: b.recipeId,
          label: b.label,
          disabledPorts: b.disabledPorts ? [...b.disabledPorts] : undefined,
          priorityIn: b.priorityIn,
          priorityOut: b.priorityOut,
          portFilters: b.portFilters ? { ...b.portFilters } : undefined,
          filterItems: b.filterItems ? [...b.filterItems] : undefined,
        });
        const def = getBuildableDef(b.type);
        const parts: string[] = [getShortLabel(b.type, def?.nameZh)];
        if (b.recipeId) {
          const rec = getRecipeDef(b.recipeId);
          if (rec) parts.push(rec.nameZh);
        }
        if (b.label) parts.push(b.label);
        if (b.priorityIn !== undefined || b.priorityOut !== undefined) parts.push('含优先级');
        if (b.portFilters && Object.keys(b.portFilters).length > 0) parts.push('含口过滤');
        if (b.filterItems && b.filterItems.length > 0) parts.push(`过滤${b.filterItems.length}项`);
        if (def?.configurablePorts && b.disabledPorts && b.disabledPorts.length > 0) {
          const toggleableCount = getToggleablePorts(def).length;
          parts.push(`${Math.max(0, toggleableCount - b.disabledPorts.length)}/${toggleableCount}口`);
        }
        showToast(`吸管复制：${parts.join(' · ')}`);
      }
    },
    [selectEntityTool, showToast]
  );

  const handleCancelAction = useCallback(() => {
    const { activeTool: tool, selection: sel } = stateRef.current;
    if (tool.kind !== 'select') {
      setActiveTool({ kind: 'select' });
      setStampingLibPath(null);
      setBeltPreview([]);
      return;
    }
    if (sel.moduleIds.length > 0 || sel.buildingIds.length > 0) {
      setSelection(EMPTY_SELECTION);
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceHeldRef.current = true;
      if (e.key === 'Shift') setForceReplaceHeld(true);
      if (isTextInputFocused(e.target)) return;

      if (
        ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code) &&
        !e.ctrlKey &&
        !e.metaKey
      ) {
        sceneRef.current?.setKeyDown(e.code, true);
        return;
      }

      const mod = e.ctrlKey || e.metaKey;
      const lower = e.key.toLowerCase();

      if (mod) {
        if (lower === 'z' && !e.shiftKey) {
          e.preventDefault();
          setHistory((h) => undoHistory(h));
          return;
        }
        if ((lower === 'z' && e.shiftKey) || lower === 'y') {
          e.preventDefault();
          setHistory((h) => redoHistory(h));
          return;
        }
        if (lower === 'c') {
          e.preventDefault();
          copySelectionToGhost(false);
          return;
        }
        if (lower === 'x') {
          e.preventDefault();
          copySelectionToGhost(true);
          return;
        }
        if (lower === 'v') {
          e.preventDefault();
          const cb = stateRef.current.clipboardBp;
          if (cb) {
            setActiveTool({ kind: 'stamp-blueprint', blueprint: cb, name: cb.name, rotation: 0, floorOffset: 0 });
            setStampingLibPath(null);
            showToast('已唤出剪贴板蓝图');
          }
          return;
        }
        if (lower === 's') {
          e.preventDefault();
          openSaveDialog(true);
          return;
        }
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        if (helpOpen) { setHelpOpen(false); return; }
        if (saveDialog) { setSaveDialog(null); return; }
        if (deleteConfirm) { setDeleteConfirm(null); return; }
        handleCancelAction();
        return;
      }
      if (e.code === 'Backquote') {
        e.preventDefault();
        switchViewMode(stateRef.current.viewMode === 'station' ? 'building' : 'station');
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const { activeTool: tool, viewMode: vm } = stateRef.current;
        const delta: 1 | -1 = e.shiftKey ? -1 : 1;
        if (tool.kind === 'place-module' && vm === 'station') {
          const next = cycleVariantInGroup('station', tool.moduleType, delta);
          if (next) selectEntityTool(next);
          return;
        }
        if (tool.kind === 'place-building' && vm === 'building') {
          const next = cycleVariantInGroup('building', tool.buildingType, delta);
          if (next) selectEntityTool(next);
          return;
        }
        switchViewMode(vm === 'station' ? 'building' : 'station');
        return;
      }
      if (e.key === 'F1' || e.key === '?') {
        e.preventDefault();
        setHelpOpen((o) => !o);
        return;
      }
      if (lower === 'e') {
        e.preventDefault();
        setFocusFloor((f) => Math.min(8, f + 1));
        return;
      }
      if (lower === 'q') {
        e.preventDefault();
        setFocusFloor((f) => Math.max(-2, f - 1));
        return;
      }
      if (lower === 'v') {
        e.preventDefault();
        setHideAbove((v) => !v);
        return;
      }
      if (lower === 'g') {
        e.preventDefault();
        setSnapEnabled((s) => {
          const next = !s;
          sceneRef.current?.rig.setSnapEnabled(next);
          showToast(next ? '视角吸附已开启（四向 + 固定俯角）' : '已切换为自由无级 3D 视角');
          return next;
        });
        return;
      }
      if (lower === 'b') {
        e.preventDefault();
        setSelectionLayerMode((m) => {
          const next: SelectionLayerMode = m === 'focus' ? 'visible' : m === 'visible' ? 'all' : 'focus';
          const names = { focus: '仅当前焦点层', visible: '当前可见层', all: '全部楼层' };
          showToast(`框选层域：${names[next]}`);
          return next;
        });
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        fitAllStation();
        return;
      }
      if (lower === 'f') {
        e.preventDefault();
        const tool = stateRef.current.activeTool;
        if (
          tool.kind === 'place-module' &&
          (tool.moduleType === 'BPO_StationArmour_01' || tool.moduleType === 'BPO_StationArmour_01B')
        ) {
          const flipped = tool.moduleType === 'BPO_StationArmour_01' ? 'BPO_StationArmour_01B' : 'BPO_StationArmour_01';
          selectEntityTool(flipped, { rotation: tool.rotation, label: tool.label });
          showToast(flipped === 'BPO_StationArmour_01' ? '已翻转为顶面装甲（Z: 0..+4m）' : '已翻转为底面装甲（Z: -4..0m）');
          return;
        }
        focusSelection();
        return;
      }
      if (lower === 'x') {
        e.preventDefault();
        setActiveTool((t) => (t.kind === 'demolish' ? { kind: 'select' } : { kind: 'demolish' }));
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        requestDeleteSelection(stateRef.current.selection);
        return;
      }
      if (lower === 'r') {
        e.preventDefault();
        if (dragRef.current.kind === 'belt-plan') {
          dragRef.current.beltFlipCorner = !dragRef.current.beltFlipCorner;
          if (dragRef.current.startWorld && cursorWorld) {
            const tool = stateRef.current.activeTool;
            const fallback = tool.kind === 'place-building' ? tool.rotation : 0;
            setBeltPreview(
              buildPlannedBeltPath(
                [Math.floor(dragRef.current.startWorld.x), Math.floor(dragRef.current.startWorld.y)],
                [Math.floor(cursorWorld.x), Math.floor(cursorWorld.y)],
                {
                  flipCorner: dragRef.current.beltFlipCorner,
                  reverse: dragRef.current.beltReverse,
                  fallbackRotation: fallback,
                }
              )
            );
          }
          return;
        }
        const delta: 1 | -1 = e.shiftKey ? -1 : 1;
        const tool = stateRef.current.activeTool;
        if (tool.kind === 'place-module') {
          setActiveTool({ ...tool, rotation: normalizeRotation(tool.rotation + delta) });
        } else if (tool.kind === 'place-building') {
          setActiveTool({ ...tool, rotation: normalizeRotation(tool.rotation + delta) });
        } else if (tool.kind === 'stamp-blueprint') {
          setActiveTool({
            ...tool,
            blueprint: rotateBlueprint(tool.blueprint, delta),
            rotation: normalizeRotation(tool.rotation + delta),
          });
        } else {
          const res = rotateSelectionInPlaceCmd(stateRef.current.doc, stateRef.current.selection, delta);
          if (res.changed) commitDoc(res.doc);
        }
        return;
      }
      if (lower === 'm') {
        e.preventDefault();
        const tool = stateRef.current.activeTool;
        if (tool.kind === 'stamp-blueprint') {
          setActiveTool({ ...tool, blueprint: mirrorBlueprintX(tool.blueprint) });
          showToast('已水平镜像翻转蓝图');
        } else if (
          tool.kind === 'place-module' &&
          (tool.moduleType === 'BPO_StationArmour_01' || tool.moduleType === 'BPO_StationArmour_01B')
        ) {
          const flipped = tool.moduleType === 'BPO_StationArmour_01' ? 'BPO_StationArmour_01B' : 'BPO_StationArmour_01';
          selectEntityTool(flipped, { rotation: tool.rotation, label: tool.label });
          showToast(flipped === 'BPO_StationArmour_01' ? '已翻转为顶面装甲（Z: 0..+4m）' : '已翻转为底面装甲（Z: -4..0m）');
        }
        return;
      }
      if (e.key === 'Alt' && dragRef.current.kind === 'belt-plan') {
        e.preventDefault();
        dragRef.current.beltReverse = !dragRef.current.beltReverse;
        return;
      }
      if (lower === 'o') {
        e.preventDefault();
        const sel = stateRef.current.selection;
        if (sel.buildingIds.length === 1) {
          const chain = selectConnectedBeltChain(stateRef.current.doc, sel.buildingIds[0]);
          setSelection({ moduleIds: [], buildingIds: chain });
          showToast(`已选中整条连通传送带（共 ${chain.length} 节）`);
        }
        return;
      }
      if (lower === 'c') {
        e.preventDefault();
        if (cursorWorld) pipetteAtWorld(cursorWorld);
        return;
      }

      if (/^[1-9]$/.test(e.key)) {
        const slot = Number(e.key);
        const { viewMode: vm, activeTool: tool, lastGroupMember: mem } = stateRef.current;
        const group = getGroupsForView(vm).find((g) => g.slot === slot);
        if (!group) return;
        const curId =
          vm === 'station' && tool.kind === 'place-module'
            ? tool.moduleType
            : vm === 'building' && tool.kind === 'place-building'
              ? tool.buildingType
              : null;
        if (curId && group.members.includes(curId) && group.members.length > 1) {
          const next = cycleVariantInGroup(vm, curId, e.shiftKey ? -1 : 1);
          if (next) selectEntityTool(next);
        } else {
          const target = mem[group.id] ?? group.members[0];
          if (target) selectEntityTool(target);
        }
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceHeldRef.current = false;
      if (e.key === 'Shift') setForceReplaceHeld(false);
      sceneRef.current?.setKeyDown(e.code, false);
    };

    const onBlur = () => {
      spaceHeldRef.current = false;
      setForceReplaceHeld(false);
      sceneRef.current?.clearKeys();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [
    commitDoc,
    copySelectionToGhost,
    cursorWorld,
    deleteConfirm,
    fitAllStation,
    focusSelection,
    handleCancelAction,
    helpOpen,
    openSaveDialog,
    pipetteAtWorld,
    requestDeleteSelection,
    saveDialog,
    selectEntityTool,
    showToast,
    switchViewMode,
  ]);

  const clientToWorld = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const el = viewportRef.current;
    const ctrl = sceneRef.current;
    if (!el || !ctrl) return null;
    const rect = el.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
    const hit = ctrl.rig.intersectFocusPlane(ndcX, ndcY);
    return hit ? { x: hit.x, y: hit.z } : null;
  }, []);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const world = clientToWorld(e.clientX, e.clientY);
    if (world) setCursorWorld(world);

    if (e.button === 2) {
      dragRef.current = {
        ...dragRef.current,
        kind: 'orbit',
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        moved: false,
      };
      return;
    }

    if (e.button === 1 || (e.button === 0 && spaceHeldRef.current)) {
      dragRef.current = {
        ...dragRef.current,
        kind: 'pan',
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        moved: false,
        startWorld: world,
      };
      return;
    }

    if (e.button !== 0 || !world) return;
    const { doc: curDoc, viewMode: vm, focusFloor: fl, activeTool: tool } = stateRef.current;

    if (tool.kind === 'demolish') {
      dragRef.current = {
        ...dragRef.current,
        kind: 'demolish',
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        moved: false,
      };
      if (vm === 'building') {
        const b = findBuildingAtCell(curDoc, Math.floor(world.x), Math.floor(world.y), fl);
        if (b) {
          const res = deleteSelectionCmd(curDoc, { moduleIds: [], buildingIds: [b.id] });
          if (res.changed) commitDoc(res.doc);
        }
      } else {
        const m = findModuleAtWorldPoint(curDoc, world.x, world.y, fl);
        if (m) requestDeleteSelection({ moduleIds: [m.id], buildingIds: [] });
      }
      return;
    }

    if (tool.kind === 'place-module') {
      const gx = Math.floor(world.x / STATION_UNIT_M);
      const gy = Math.floor(world.y / STATION_UNIT_M);
      const res = placeModuleCmd(curDoc, {
        type: tool.moduleType,
        gx,
        gy,
        floor: fl,
        rotation: tool.rotation,
        ...(tool.label ? { label: tool.label } : {}),
      });
      if (res.changed) commitDoc(res.doc);
      else if (res.message) showToast(res.message, 'warn');
      return;
    }

    if (tool.kind === 'place-building') {
      const def = getBuildableDef(tool.buildingType);
      if (!def) return;
      if (def.kind === 'belt') {
        const cell: [number, number] = [Math.floor(world.x), Math.floor(world.y)];
        const isPlanner = e.shiftKey;
        dragRef.current = {
          ...dragRef.current,
          kind: isPlanner ? 'belt-plan' : 'belt-stroke',
          startX: e.clientX,
          startY: e.clientY,
          lastX: e.clientX,
          lastY: e.clientY,
          moved: false,
          startWorld: world,
          beltCells: [cell],
          beltFlipCorner: false,
          beltReverse: e.altKey,
        };
        setBeltPreview([{ x: cell[0], y: cell[1], rotation: tool.rotation }]);
        return;
      }

      const [w, d] = getBuildingSizeCells(def, tool.rotation);
      const bx = Math.floor(world.x - w / 2 + 0.5);
      const by = Math.floor(world.y - d / 2 + 0.5);
      const res = placeBuildingCmd(
        curDoc,
        {
          type: tool.buildingType,
          x: bx,
          y: by,
          floor: fl,
          rotation: tool.rotation,
          undergroundMode: def.kind === 'underground' ? (tool.undergroundMode ?? 'in') : undefined,
          ...(tool.recipeId ? { recipeId: tool.recipeId } : {}),
          ...(tool.label ? { label: tool.label } : {}),
          ...(tool.disabledPorts && tool.disabledPorts.length > 0 ? { disabledPorts: [...tool.disabledPorts] } : {}),
          ...(tool.priorityIn !== undefined ? { priorityIn: tool.priorityIn } : {}),
          ...(tool.priorityOut !== undefined ? { priorityOut: tool.priorityOut } : {}),
          ...(tool.portFilters && Object.keys(tool.portFilters).length > 0 ? { portFilters: { ...tool.portFilters } } : {}),
          ...(tool.filterItems && tool.filterItems.length > 0 ? { filterItems: [...tool.filterItems] } : {}),
        },
        { allowForceReplace: e.shiftKey }
      );
      if (res.changed) {
        commitDoc(res.doc);
        if (def.kind === 'underground') {
          setActiveTool({ ...tool, undergroundMode: tool.undergroundMode === 'out' ? 'in' : 'out' });
        }
      } else if (res.message) {
        showToast(res.message, 'warn');
      }
      return;
    }

    if (tool.kind === 'stamp-blueprint') {
      const res = stampBlueprintCmd(
        curDoc,
        tool.blueprint,
        { x: Math.floor(world.x), y: Math.floor(world.y), floor: fl + tool.floorOffset },
        { forceReplace: e.shiftKey }
      );
      if (res.changed) {
        commitDoc(res.doc);
        showToast(`已盖章粘贴「${tool.name}」`);
      } else if (res.message) {
        showToast(res.message, 'warn');
      }
      return;
    }

    dragRef.current = {
      ...dragRef.current,
      kind: 'box-select',
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      moved: false,
      startWorld: world,
      boxModifier: e.shiftKey ? 'add' : e.altKey ? 'sub' : 'replace',
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const world = clientToWorld(e.clientX, e.clientY);
    if (world) setCursorWorld(world);

    const d = dragRef.current;
    if (d.kind === 'none') return;

    const dx = e.clientX - d.lastX;
    const dy = e.clientY - d.lastY;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) >= 5) {
      d.moved = true;
    }

    if (d.kind === 'orbit') {
      sceneRef.current?.rig.orbitByPixels(dx, dy);
      return;
    }
    if (d.kind === 'pan') {
      const h = viewportRef.current?.clientHeight || 600;
      sceneRef.current?.rig.panByScreenDelta(dx, dy, h);
      return;
    }
    if (!world) return;

    if (d.kind === 'box-select' && d.moved && d.startWorld) {
      setBoxSelectRect({
        minX: Math.min(d.startWorld.x, world.x),
        minY: Math.min(d.startWorld.y, world.y),
        maxX: Math.max(d.startWorld.x, world.x),
        maxY: Math.max(d.startWorld.y, world.y),
      });
      return;
    }

    if (d.kind === 'belt-stroke') {
      const cell: [number, number] = [Math.floor(world.x), Math.floor(world.y)];
      const nextCells = extendBeltStroke(d.beltCells, cell);
      if (nextCells !== d.beltCells) {
        d.beltCells = nextCells;
        const tool = stateRef.current.activeTool;
        const fallback = tool.kind === 'place-building' ? tool.rotation : 0;
        setBeltPreview(cellsToBeltSpecs(nextCells, fallback, e.altKey));
      }
      return;
    }

    if (d.kind === 'belt-plan' && d.startWorld) {
      const tool = stateRef.current.activeTool;
      const fallback = tool.kind === 'place-building' ? tool.rotation : 0;
      setBeltPreview(
        buildPlannedBeltPath(
          [Math.floor(d.startWorld.x), Math.floor(d.startWorld.y)],
          [Math.floor(world.x), Math.floor(world.y)],
          { flipCorner: d.beltFlipCorner, reverse: d.beltReverse || e.altKey, fallbackRotation: fallback }
        )
      );
      return;
    }

    if (d.kind === 'demolish' && stateRef.current.viewMode === 'building') {
      const curDoc = stateRef.current.doc;
      const b = findBuildingAtCell(curDoc, Math.floor(world.x), Math.floor(world.y), stateRef.current.focusFloor);
      if (b) {
        const res = deleteSelectionCmd(curDoc, { moduleIds: [], buildingIds: [b.id] });
        if (res.changed) commitDoc(res.doc);
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    const world = clientToWorld(e.clientX, e.clientY);

    if (d.kind === 'orbit') {
      if (!d.moved) {
        handleCancelAction();
      } else {
        sceneRef.current?.rig.snapAngles();
      }
    } else if (d.kind === 'pan' && !d.moved && e.button === 1 && world) {
      pipetteAtWorld(world);
    } else if (d.kind === 'box-select') {
      const { doc: curDoc, viewMode: vm, focusFloor: fl, selection: prevSel, hideAbove: ha, selectionLayerMode: slm } =
        stateRef.current;
      if (d.moved && d.startWorld && world) {
        const hitSel = boxSelectEntities(
          curDoc,
          {
            minX: Math.min(d.startWorld.x, world.x),
            minY: Math.min(d.startWorld.y, world.y),
            maxX: Math.max(d.startWorld.x, world.x),
            maxY: Math.max(d.startWorld.y, world.y),
          },
          { viewMode: vm, focusFloor: fl, hideAbove: ha, layerMode: slm }
        );
        if (d.boxModifier === 'add') {
          setSelection({
            moduleIds: Array.from(new Set([...prevSel.moduleIds, ...hitSel.moduleIds])),
            buildingIds: Array.from(new Set([...prevSel.buildingIds, ...hitSel.buildingIds])),
          });
        } else if (d.boxModifier === 'sub') {
          const rmM = new Set(hitSel.moduleIds);
          const rmB = new Set(hitSel.buildingIds);
          setSelection({
            moduleIds: prevSel.moduleIds.filter((id) => !rmM.has(id)),
            buildingIds: prevSel.buildingIds.filter((id) => !rmB.has(id)),
          });
        } else {
          setSelection(hitSel);
        }
      } else if (world) {
        if (vm === 'building') {
          const b = findBuildingAtCell(curDoc, Math.floor(world.x), Math.floor(world.y), fl);
          if (b) {
            if (e.shiftKey) {
              const exists = prevSel.buildingIds.includes(b.id);
              setSelection({
                moduleIds: prevSel.moduleIds,
                buildingIds: exists ? prevSel.buildingIds.filter((x) => x !== b.id) : [...prevSel.buildingIds, b.id],
              });
            } else {
              setSelection({ moduleIds: [], buildingIds: [b.id] });
            }
          } else if (!e.shiftKey) {
            setSelection(EMPTY_SELECTION);
          }
        } else {
          const m = findModuleAtWorldPoint(curDoc, world.x, world.y, fl);
          if (m) {
            if (e.shiftKey) {
              const exists = prevSel.moduleIds.includes(m.id);
              setSelection({
                moduleIds: exists ? prevSel.moduleIds.filter((x) => x !== m.id) : [...prevSel.moduleIds, m.id],
                buildingIds: prevSel.buildingIds,
              });
            } else {
              setSelection({ moduleIds: [m.id], buildingIds: [] });
            }
          } else if (!e.shiftKey) {
            setSelection(EMPTY_SELECTION);
          }
        }
      }
      setBoxSelectRect(null);
    } else if (d.kind === 'belt-stroke' || d.kind === 'belt-plan') {
      const tool = stateRef.current.activeTool;
      if (tool.kind === 'place-building' && beltPreview.length > 0) {
        const res = placeBeltRunCmd(stateRef.current.doc, tool.buildingType, stateRef.current.focusFloor, beltPreview);
        if (res.changed) commitDoc(res.doc);
      }
      setBeltPreview([]);
    }

    dragRef.current.kind = 'none';
    dragRef.current.moved = false;
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = viewportRef.current;
    const ctrl = sceneRef.current;
    if (!el || !ctrl) return;
    const rect = el.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    const hit = ctrl.rig.intersectFocusPlane(ndcX, ndcY);
    ctrl.rig.zoomByWheel(e.deltaY, hit);
  };

  const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (stateRef.current.activeTool.kind !== 'select') return;
    const world = clientToWorld(e.clientX, e.clientY);
    if (!world) return;
    if (stateRef.current.viewMode === 'station') {
      const mod = findModuleAtWorldPoint(stateRef.current.doc, world.x, world.y, stateRef.current.focusFloor);
      if (mod) {
        const def = getModuleDef(mod.type);
        if (def?.hasFactoryFloor) {
          const [x0, y0, x1, y1] = getModuleBoundsM(mod, def);
          switchViewMode('building', [(x0 + x1) / 2, (y0 + y1) / 2]);
        }
      }
    }
  };

  const handleMountLocalFolder = async () => {
    try {
      const fsDrv = await FileSystemFolderDriver.pickDirectory();
      setDriver(fsDrv);
      showToast(`已挂载本地文件夹：${fsDrv.rootLabel}`);
    } catch (err) {
      if ((err as { name?: string })?.name !== 'AbortError') {
        showToast(`挂载失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    }
  };

  const handleStampFromLibrary = async (file: LibraryFileEntry) => {
    try {
      const { doc: loaded } = await driver.readBlueprint(file.path);
      setStampingLibPath(file.path);
      setActiveTool({
        kind: 'stamp-blueprint',
        blueprint: loaded,
        name: loaded.name || file.name,
        rotation: 0,
        floorOffset: 0,
      });
      showToast(`已加载蓝图「${loaded.name}」到光标（左键盖章 / R旋转 / M镜像）`);
    } catch (err) {
      showToast(`读取蓝图失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  const handleOpenFromLibrary = async (file: LibraryFileEntry) => {
    if (dirty && !window.confirm('当前画布有未保存更改，确定打开新蓝图覆盖当前工作区吗？')) return;
    try {
      const { doc: loaded, warnings } = await driver.readBlueprint(file.path);
      setHistory(createHistory(loaded));
      setActiveSourcePath(file.path);
      setDirty(false);
      setSelection(EMPTY_SELECTION);
      setActiveTool({ kind: 'select' });
      setStampingLibPath(null);
      showToast(warnings.length > 0 ? `已打开（提示：${warnings[0]}）` : `已打开「${loaded.name}」`);
      window.setTimeout(() => fitAllStation(), 60);
    } catch (err) {
      showToast(`打开失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  const handleExportFromLibrary = async (file: LibraryFileEntry) => {
    try {
      const { doc: loaded } = await driver.readBlueprint(file.path);
      const blob = new Blob([serializeBlueprint(loaded)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = sanitizeFileName(loaded.name || file.name);
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      showToast(`导出失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  const handleImportJsonFile = async (file: File) => {
    try {
      const text = await file.text();
      const decoded = deserializeBlueprint(text);
      if (!decoded.ok) {
        showToast(decoded.error, 'error');
        return;
      }
      const targetPath = `导入蓝图/${sanitizeFileName(decoded.doc.name || file.name)}`;
      await driver.writeBlueprint(targetPath, decoded.doc);
      await refreshLibrary();
      showToast(`已导入至 ${targetPath}${decoded.warnings.length ? `（${decoded.warnings[0]}）` : ''}`);
    } catch (err) {
      showToast(`导入失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  const handleCreateFolder = async (parentFolder: string) => {
    const name = window.prompt('输入新文件夹名称：', '新建分类');
    if (!name || !name.trim()) return;
    const rel = parentFolder ? `${parentFolder}/${name.trim()}` : name.trim();
    try {
      await driver.createFolder(rel);
      await refreshLibrary();
      showToast(`已创建文件夹：${rel}`);
    } catch (err) {
      showToast(`创建失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  const handleDeleteLibEntry = async (relPath: string, isFolder: boolean) => {
    const ok = window.confirm(
      isFolder ? `确定删除文件夹「${relPath}」及其中的全部蓝图吗？` : `确定删除蓝图文件「${relPath}」吗？`
    );
    if (!ok) return;
    try {
      await driver.deleteEntry(relPath);
      if (activeSourcePath === relPath) setActiveSourcePath(null);
      await refreshLibrary();
      showToast(`已删除 ${relPath}`);
    } catch (err) {
      showToast(`删除失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  const handleMoveLibFile = async (fromPath: string, targetFolder: string) => {
    const fileName = fromPath.split('/').pop()!;
    const toPath = targetFolder ? `${targetFolder}/${fileName}` : fileName;
    if (normalizeRelPath(fromPath) === normalizeRelPath(toPath)) return;
    try {
      await driver.moveEntry(fromPath, toPath);
      if (activeSourcePath === fromPath) setActiveSourcePath(toPath);
      await refreshLibrary();
      showToast(`已移动至 ${toPath}`);
    } catch (err) {
      showToast(`移动失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  const handleNewBlueprint = () => {
    if (dirty && !window.confirm('当前画布有未保存更改，确定新建空白空间站吗？')) return;
    const fresh = createEmptyBlueprint('新建空间站');
    setHistory(createHistory(fresh));
    setActiveSourcePath(null);
    setDirty(false);
    setSelection(EMPTY_SELECTION);
    setActiveTool({ kind: 'place-module', moduleType: 'BPO_Station_02A', rotation: 0 });
    setViewMode('station');
    sceneRef.current?.rig.setViewMode('station', true);
    sceneRef.current?.rig.focusPoint(16, 16, 76);
  };

  const folderOptions = useMemo(() => collectFolderPaths(libraryTree), [libraryTree]);

  return (
    <div className="cad-shell" data-theme={theme}>
      <header className="cad-topbar">
        <div className="topbar-group">
          <span className="brand-mark">MS · CAD</span>
          <input
            id="doc-title"
            name="docTitle"
            type="text"
            className="doc-title-input"
            value={doc.name}
            onChange={(e) => {
              const name = e.target.value;
              setHistory((h) => ({ ...h, present: { ...h.present, name } }));
              setDirty(true);
            }}
            title="点击修改当前蓝图名称"
          />
          <span className={`dirty-pill ${dirty ? 'dirty' : 'clean'}`}>
            {dirty ? '未保存' : activeSourcePath ? '已保存' : '草稿'}
          </span>
        </div>

        <div className="topbar-group segmented">
          <button
            type="button"
            className={`seg-btn ${viewMode === 'station' ? 'active' : ''}`}
            onClick={() => switchViewMode('station')}
            title="空间站视野 (` 或选择态 Tab)"
          >
            空间站
          </button>
          <button
            type="button"
            className={`seg-btn ${viewMode === 'building' ? 'active' : ''}`}
            onClick={() => switchViewMode('building')}
            title="建筑视野 (` 或选择态 Tab)"
          >
            建筑
          </button>
        </div>

        <div className="topbar-group">
          <div className="floor-stepper" title="焦点楼层 (Q 降 / E 升)">
            <button type="button" className="step-btn" onClick={() => setFocusFloor((f) => Math.max(-2, f - 1))}>
              Q↓
            </button>
            <span className="floor-readout">L{focusFloor}</span>
            <button type="button" className="step-btn" onClick={() => setFocusFloor((f) => Math.min(8, f + 1))}>
              E↑
            </button>
          </div>
          <button
            type="button"
            className="cad-btn"
            onClick={() => setHideAbove((v) => !v)}
            title="切换是否隐藏焦点楼层以上所有层 (V)"
          >
            {hideAbove ? '上层 · 隐藏' : '上层 · 透视'}
          </button>
        </div>

        <div className="topbar-group">
          <button
            type="button"
            className="cad-btn"
            onClick={() => {
              const next = !snapEnabled;
              setSnapEnabled(next);
              sceneRef.current?.rig.setSnapEnabled(next);
            }}
            title="切换四向与固定俯角吸附 (G)"
          >
            {snapEnabled ? '吸附 · 开' : '吸附 · 关'}
          </button>
          <button
            type="button"
            className="cad-btn"
            onClick={() => sceneRef.current?.rig.stepYawCardinal(1)}
            title="顺时针切换正交朝向 90°"
          >
            ↻90°
          </button>
          <div className="pitch-pills">
            {PITCH_SNAP_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className="mini-pill"
                onClick={() => sceneRef.current?.rig.setPitchPreset(p.rad)}
                title={`切换到${p.label}`}
              >
                {p.label.slice(0, 2)}
              </button>
            ))}
          </div>
        </div>

        <div className="topbar-group right-aligned">
          <button
            type="button"
            className={`cad-btn ${simOpen ? (simReport?.passed ? 'sim-ok' : 'sim-err') : ''}`}
            onClick={() => setSimOpen((v) => !v)}
            title="开启/关闭实时产线模拟、流量计算与零异常体检"
          >
            {simOpen
              ? simReport?.passed
                ? '模拟 · 0异常'
                : `模拟 · ${simReport?.errorCount ?? 0}异常`
              : '产线模拟'}
          </button>
          <button
            type="button"
            className="cad-btn"
            onClick={() =>
              setSelectionLayerMode((m) => (m === 'focus' ? 'visible' : m === 'visible' ? 'all' : 'focus'))
            }
            title="切换框选跨层范围 (B)"
          >
            框选 · {selectionLayerMode === 'focus' ? '当前层' : selectionLayerMode === 'visible' ? '可见层' : '全部层'}
          </button>
          <button
            type="button"
            className="cad-btn"
            disabled={history.past.length === 0}
            onClick={() => setHistory((h) => undoHistory(h))}
            title="撤销 (Ctrl+Z)"
          >
            撤销
          </button>
          <button
            type="button"
            className="cad-btn"
            disabled={history.future.length === 0}
            onClick={() => setHistory((h) => redoHistory(h))}
            title="重做 (Ctrl+Shift+Z)"
          >
            重做
          </button>
          <button
            type="button"
            className="cad-btn"
            onClick={() => {
              const next: CadThemeId = theme === 'platinum-gold' ? 'stealth-cad' : 'platinum-gold';
              setTheme(next);
              saveTheme(next);
            }}
            title="切换外观主题（白金香槟 / 工程白图·办公伪装）"
          >
            主题 · {CAD_THEMES[theme].nameZh}
          </button>
          <button type="button" className="cad-btn" onClick={() => openSaveDialog(false)} title="保存蓝图 (Ctrl+S)">
            保存
          </button>
          <button
            type="button"
            className="cad-btn"
            onClick={() => setHelpOpen((o) => !o)}
            title="操作快捷键与帮助 (F1 / ?)"
          >
            {helpOpen ? '关闭帮助' : '快捷键'}
          </button>
        </div>
      </header>

      <div className="cad-main">
        <LibrarySidebar
          open={libraryOpen}
          onToggleOpen={() => setLibraryOpen((o) => !o)}
          driverMode={driver.mode}
          rootLabel={driver.rootLabel}
          fsSupported={FileSystemFolderDriver.isSupported()}
          tree={libraryTree}
          activeSourcePath={activeSourcePath}
          stampingPath={stampingLibPath}
          onMountLocalFolder={handleMountLocalFolder}
          onRefresh={() => void refreshLibrary()}
          onNewBlueprint={handleNewBlueprint}
          onCreateFolder={handleCreateFolder}
          onImportJsonFile={handleImportJsonFile}
          onStampFromLibrary={handleStampFromLibrary}
          onOpenFromLibrary={handleOpenFromLibrary}
          onExportFromLibrary={handleExportFromLibrary}
          onDeleteEntry={handleDeleteLibEntry}
          onMoveFile={handleMoveLibFile}
        />

        <div
          ref={viewportRef}
          className={`cad-viewport tool-${activeTool.kind}`}
          onContextMenu={(e) => e.preventDefault()}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={() => setCursorWorld(null)}
          onWheel={handleWheel}
          onDoubleClick={handleDoubleClick}
        />

        <div className="cad-focal-vignette" aria-hidden="true" />

        <InspectorPanel
          doc={doc}
          selection={selection}
          onUpdateBuilding={(ids, patch) => {
            const res = updateBuildingConfigCmd(doc, ids, patch);
            if (res.changed) commitDoc(res.doc);
          }}
          onUpdateModuleLabel={(id, label) => {
            const res = updateModuleLabelCmd(doc, id, label);
            if (res.changed) commitDoc(res.doc);
          }}
          onCopySelection={() => copySelectionToGhost(false)}
          onSaveSelectionAsBlueprint={() => openSaveDialog(true)}
          onRotateSelection={() => {
            const res = rotateSelectionInPlaceCmd(doc, selection, 1);
            if (res.changed) commitDoc(res.doc);
          }}
          onDeleteSelection={() => requestDeleteSelection(selection)}
          onClearSelection={() => setSelection(EMPTY_SELECTION)}
        />

        <SimulationPanel
          open={simOpen}
          report={simReport}
          onClose={() => setSimOpen(false)}
          onFocusIssue={(issue: SimulationIssue) => {
            setFocusFloor(issue.floor);
            switchViewMode('building', [issue.x + 0.5, issue.y + 0.5]);
            if (issue.buildingId) {
              setSelection({ moduleIds: [], buildingIds: [issue.buildingId] });
            }
          }}
        />

        {activeTool.kind !== 'select' && (
          <div className="cad-tool-banner">
            {activeTool.kind === 'demolish' && '拆除刷 · 左键扫过拆除 · 右键 / Esc 退出'}
            {activeTool.kind === 'place-module' &&
              `${getShortLabel(activeTool.moduleType, getModuleDef(activeTool.moduleType)?.nameZh)}${
                activeTool.label ? ` [${activeTool.label}]` : ''
              }${
                activeTool.moduleType === 'BPO_StationArmour_01' || activeTool.moduleType === 'BPO_StationArmour_01B'
                  ? ' · M/F 上下翻转'
                  : ''
              } · Tab 组内轮换 · R 旋转 · Q/E 切层 · 右键取消`}
            {activeTool.kind === 'place-building' &&
              `${getShortLabel(activeTool.buildingType, getBuildableDef(activeTool.buildingType)?.nameZh)}${
                activeTool.recipeId ? ` [${getRecipeDef(activeTool.recipeId)?.nameZh ?? activeTool.recipeId}]` : ''
              }${activeTool.label ? ` · ${activeTool.label}` : ''}${
                activeTool.disabledPorts && activeTool.disabledPorts.length > 0
                  ? ` · 禁${activeTool.disabledPorts.length}口`
                  : ''
              }${
                getBuildableDef(activeTool.buildingType)?.kind === 'belt'
                  ? ' · 左键拖拉 · Shift+拖 L形规划 · Tab 换级'
                  : getBuildableDef(activeTool.buildingType)?.kind === 'underground'
                    ? ` (${activeTool.undergroundMode === 'out' ? '出口 OUT' : '入口 IN'}) · Tab 换级`
                    : ' · Tab 组内轮换 · R 旋转 · Shift+左键覆盖'
              } · 右键取消`}
            {activeTool.kind === 'stamp-blueprint' &&
              `幽灵蓝图「${activeTool.name}」 · 左键盖章 · Shift 覆盖 · R 旋转 · M 镜像 · 右键放下`}
          </div>
        )}

        <div className="cad-telemetry">
          <span>{viewMode === 'station' ? '空间站' : '建筑'}</span>
          <span>
            {cursorWorld ? `${Math.floor(cursorWorld.x)}, ${Math.floor(cursorWorld.y)}` : '--'} · L{focusFloor}
          </span>
          <span>
            {telemetry.yawDeg}° / {telemetry.pitchDeg}° · {telemetry.distance}m
          </span>
          <span>
            {doc.modules.length}模 · {doc.buildings.length}建
            {lastAutosaveAt ? ` · ${new Date(lastAutosaveAt).toLocaleTimeString()}` : ''}
          </span>
        </div>

        <PaletteDock
          viewMode={viewMode}
          activeTool={activeTool}
          lastGroupMember={lastGroupMember}
          onSelectEntity={(id) => selectEntityTool(id)}
          onSelectTool={(t) => {
            setActiveTool(t);
            setStampingLibPath(null);
          }}
        />

        {toast && <div className={`cad-toast ${toast.kind}`}>{toast.text}</div>}
      </div>

      <HelpDrawer open={helpOpen} onClose={() => setHelpOpen(false)} />

      {saveDialog && (
        <div className="cad-modal-overlay" onClick={() => setSaveDialog(null)}>
          <div className="cad-modal" onClick={(e) => e.stopPropagation()}>
            <div className="panel-header">
              <div className="panel-title-wrap">
                <span className="panel-tag">SAVE</span>
                <span className="panel-title">
                  {saveDialog.mode === 'selection' ? '保存选区为新蓝图' : '保存当前空间站蓝图'}
                </span>
              </div>
              <button type="button" className="icon-btn" onClick={() => setSaveDialog(null)}>×</button>
            </div>
            <div className="modal-body">
              <label className="field-label">
                <span>目标文件夹</span>
                <select
                  className="cad-input"
                  value={saveDialog.folder}
                  onChange={(e) => setSaveDialog({ ...saveDialog, folder: e.target.value })}
                >
                  {folderOptions.map((f) => (
                    <option key={f || '__root'} value={f}>
                      {f ? `/${f}` : '/（根目录）'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-label">
                <span>蓝图名称（自动保存为 .json）</span>
                <input
                  type="text"
                  className="cad-input"
                  autoFocus
                  value={saveDialog.name}
                  onChange={(e) => setSaveDialog({ ...saveDialog, name: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void executeSaveDialog();
                  }}
                />
              </label>
              <div className="modal-sub">
                包含 {saveDialog.docToSave.modules.length} 个空间站模块 · {saveDialog.docToSave.buildings.length} 个建筑
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="cad-btn" onClick={() => setSaveDialog(null)}>取消</button>
              <button type="button" className="cad-btn accent" onClick={() => void executeSaveDialog()}>
                写入本地库
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirm && (
        <div className="cad-modal-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="cad-modal" onClick={(e) => e.stopPropagation()}>
            <div className="panel-header">
              <div className="panel-title-wrap">
                <span className="panel-tag warn">CONFIRM</span>
                <span className="panel-title">确认删除含内部建筑的模块</span>
              </div>
              <button type="button" className="icon-btn" onClick={() => setDeleteConfirm(null)}>×</button>
            </div>
            <div className="modal-body">
              <p className="confirm-text">
                即将删除 <strong>{deleteConfirm.moduleCount}</strong> 个空间站模块，将一并移除其内部的{' '}
                <strong>{deleteConfirm.insideBuildingCount}</strong> 个机器/传送带（可用 Ctrl+Z 完整撤销）。
              </p>
            </div>
            <div className="modal-footer">
              <button type="button" className="cad-btn" onClick={() => setDeleteConfirm(null)}>取消</button>
              <button
                type="button"
                className="cad-btn danger"
                onClick={() => {
                  const res = deleteSelectionCmd(doc, deleteConfirm.selection, { cascadeBuildingsInModules: true });
                  if (res.changed) {
                    commitDoc(res.doc);
                    setSelection(EMPTY_SELECTION);
                  }
                  setDeleteConfirm(null);
                }}
              >
                确认一并删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
