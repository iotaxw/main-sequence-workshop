import React, { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildBeltStrokeSpecs,
  buildMultiWaypointBeltPath,
  extendBeltStrokeWithTunnels,
  getMatchingBeltType,
  getMatchingUndergroundType,
  selectConnectedBeltChain,
  stepBeltEndRotation,
  toggleBeltStrokeTunnel,
  type BeltCellSpec,
  type BeltStrokeTunnel,
  type BeltWaypoint,
} from './core/belt-router';
import { canModuleRotate, getBuildableDef, getItemName, getModuleDef, getModuleName, getRecipeDef, getRecipeName } from './core/catalog';
import { createStarterBlueprint, deserializeBlueprint, serializeBlueprint } from './core/codec';
import { DEFAULT_LIBRARY_PRESETS } from './core/presets';
import { cycleVariantInGroup, findGroupForEntity, getGroupsForView, getShortLabel } from './core/groups';
import { formatFloorTag, useI18n } from './core/i18n';
import {
  boxSelectEntities,
  commitHistory,
  createEmptyBlueprint,
  createHistory,
  deleteSelectionCmd,
  extractSelectionAsBlueprint,
  mirrorBlueprint,
  mirrorBuildingPortConfig,
  mirrorSelectionInPlaceCmd,
  placeBeltRunCmd,
  placeBuildingCmd,
  placeModuleCmd,
  redoHistory,
  rotateBlueprint,
  rotateSelectionInPlaceCmd,
  stampBlueprintCmd,
  undoHistory,
  updateBuildingConfigCmd,
  updateModuleConfigCmd,
} from './core/commands';
import {
  findBuildingAtCell,
  findModuleAtWorldPoint,
  getBuildingSizeCells,
  getFrameGridSpec,
  getMirroredBuildingRotation,
  getMirroredModuleRotation,
  getModuleBoundsM,
  getModuleSizeUnits,
  getToggleablePorts,
  normalizeRotation,
} from './core/geometry';
import {
  BlueprintLibraryDriver,
  clearSavedGitHubConfig,
  clearWorkspaceAutosave,
  FileSystemFolderDriver,
  GitHubPrivateRepoDriver,
  loadSavedGitHubConfig,
  loadWorkspaceAutosave,
  normalizeRelPath,
  sanitizeFileName,
  saveGitHubConfig,
  saveWorkspaceAutosave,
  VirtualFolderDriver,
} from './core/library';
import { exportNativeSav, importNativeSav } from './core/native-codec';
import { computeShipStats } from './core/ship-stats';
import { checkBlueprintWorkbench } from './core/workbench-check';
import type {
  ActiveTool,
  BlueprintCategory,
  BlueprintDocument,
  LibraryFileEntry,
  LibraryNode,
  Rotation,
  SelectionLayerMode,
  SelectionState,
  ViewMode,
} from './core/types';
import { PITCH_SNAP_PRESETS } from './renderer/camera-rig';
import { type BoxSelectMode, CadSceneController } from './renderer/scene-controller';
import { CAD_THEMES, type CadThemeId, loadSavedTheme, saveTheme } from './renderer/theme';
import { BlueprintLibraryModal } from './ui/BlueprintLibraryModal';
import { FloorStackRail } from './ui/FloorStackRail';
import { GameInteropMenu } from './ui/GameInteropMenu';
import { HelpDrawer } from './ui/HelpDrawer';
import { InspectorPanel } from './ui/InspectorPanel';
import { ToolActionBar, type KeyHintItem } from './ui/KeyHintBar';
import { LibrarySidebar } from './ui/LibrarySidebar';
import { PaletteDock } from './ui/PaletteDock';
import { ShipParamsHud } from './ui/ShipParamsHud';
import { SimulationPanel, type CheckFocusTarget } from './ui/SimulationPanel';
import { useHoverMenu } from './ui/useHoverMenu';

const EMPTY_SELECTION: SelectionState = { moduleIds: [], buildingIds: [] };
type PointerSample = Pick<React.PointerEvent<HTMLDivElement>, 'clientX' | 'clientY'>;

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
  const { lang, isEn, toggleLang, t } = useI18n();
  const initialSession = useMemo(() => {
    const recovered = loadWorkspaceAutosave();
    if (recovered) return recovered;
    const pubTemplate = DEFAULT_LIBRARY_PRESETS.find((p) => !p.isPrivate);
    if (pubTemplate) {
      return { savedAt: 0, sourcePath: pubTemplate.path, doc: pubTemplate.doc };
    }
    return { savedAt: 0, sourcePath: null, doc: createStarterBlueprint() };
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
  const [shipFreeRotate, setShipFreeRotate] = useState(false);
  const [selectionLayerMode, setSelectionLayerMode] = useState<SelectionLayerMode>('focus');
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION);
  const [activeTool, setActiveTool] = useState<ActiveTool>({ kind: 'select' });
  const [lastGroupMember, setLastGroupMember] = useState<Record<string, string>>({});
  const [stampingLibPath, setStampingLibPath] = useState<string | null>(null);
  const [clipboardBp, setClipboardBp] = useState<BlueprintDocument | null>(null);

  const [libraryOpen, setLibraryOpen] = useState(true);
  const [libraryModalOpen, setLibraryModalOpen] = useState(false);
  const {
    open: prefsMenuOpen,
    setOpen: setPrefsMenuOpen,
    wrapRef: prefsMenuRef,
    containerProps: prefsMenuContainerProps,
    onTriggerClick: onPrefsTriggerClick,
  } = useHoverMenu();
  const [cleanView, setCleanView] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [simOpen, setSimOpen] = useState(false);
  const [showIoSpots, setShowIoSpots] = useState(false);
  const [activeSimIssueId, setActiveSimIssueId] = useState<string | null>(null);
  const [driver, setDriver] = useState<BlueprintLibraryDriver>(() => {
    const savedGh = loadSavedGitHubConfig();
    return savedGh ? new GitHubPrivateRepoDriver(savedGh) : new VirtualFolderDriver();
  });
  const [libraryTree, setLibraryTree] = useState<LibraryNode[]>([]);
  const [ghModal, setGhModal] = useState<{
    repoSlug: string;
    branch: string;
    basePath: string;
    token: string;
    busy: boolean;
    error: string | null;
  } | null>(null);

  const simReport = useMemo(
    () => (simOpen && doc.category !== 'ship' ? checkBlueprintWorkbench(doc, lang) : null),
    [doc, simOpen, lang]
  );
  const simOverlayIssues = useMemo(() => {
    if (!simReport) return undefined;
    const markers: Array<{
      floor: number;
      x: number;
      y: number;
      severity: 'error' | 'warn';
      code?: string;
      active?: boolean;
    }> = simReport.faults.map((i) => ({
      floor: i.floor,
      x: i.x,
      y: i.y,
      severity: i.severity,
      code: i.code,
      active: i.id === activeSimIssueId,
    }));
    if (showIoSpots) {
      for (const s of simReport.ioSpots) {
        markers.push({
          floor: s.floor,
          x: s.x,
          y: s.y,
          severity: 'warn',
          code: s.direction === 'in' ? 'external-input-needed' : 'blueprint-output',
          active: s.id === activeSimIssueId,
        });
      }
    }
    return markers;
  }, [simReport, activeSimIssueId, showIoSpots]);

  const cursorWorldRef = useRef<{ x: number; y: number } | null>(null);
  const pendingPointerRef = useRef<PointerSample | null>(null);
  const processedPointerWorldRef = useRef<{ x: number; y: number } | null>(null);
  const hudCoordRef = useRef<HTMLSpanElement | null>(null);
  const hudGridRef = useRef<HTMLSpanElement | null>(null);
  const hudCamRef = useRef<HTMLSpanElement | null>(null);
  const boxBadgeRef = useRef<HTMLDivElement | null>(null);
  const hoverTipRef = useRef<HTMLDivElement | null>(null);
  const hoverTitleRef = useRef<HTMLDivElement | null>(null);
  const hoverSubRef = useRef<HTMLDivElement | null>(null);
  const hoverNoteRef = useRef<HTMLDivElement | null>(null);
  const lastHoverTipKeyRef = useRef<string>('');
  const lastHudCellRef = useRef<string>('');
  const [beltPreview, setBeltPreview] = useState<BeltCellSpec[]>([]);
  const beltPreviewRef = useRef<BeltCellSpec[]>([]);
  const [beltSessionMode, setBeltSessionMode] = useState<'plan' | 'stroke' | null>(null);
  const [beltHudFlags, setBeltHudFlags] = useState<{ tunnel: boolean; reverse: boolean }>({
    tunnel: false,
    reverse: false,
  });
  const beltSessionRef = useRef<{
    mode: 'plan' | 'stroke';
    floor: number;
    waypoints: BeltWaypoint[];
    flipCorner: boolean;
    planTunnel: boolean;
    strokeCells: Array<[number, number]>;
    strokeTunnels: BeltStrokeTunnel[];
    reverse: boolean;
    endRotation: Rotation | null;
    lastCursorCell: [number, number];
  } | null>(null);
  const [forceReplaceHeld, setForceReplaceHeld] = useState(false);
  const [toast, setToast] = useState<{ text: string; kind: 'info' | 'warn' | 'error' } | null>(null);

  const hideHoverTip = useCallback(() => {
    const el = hoverTipRef.current;
    if (el && el.style.display !== 'none') {
      el.style.display = 'none';
      lastHoverTipKeyRef.current = '';
    }
  }, []);

  const updateHoverTip = useCallback(
    (world: { x: number; y: number } | null, clientX: number, clientY: number) => {
      const el = hoverTipRef.current;
      if (!el) return;
      const {
        doc: curDoc,
        viewMode: vm,
        focusFloor: fl,
        activeTool: tool,
        simReport: curSim,
        showIoSpots: curShowIo,
        lang: curLang,
      } = stateRef.current;
      if (!world || tool.kind !== 'select' || dragRef.current.kind !== 'none') {
        hideHoverTip();
        return;
      }

      const unitM = getFrameGridSpec(curDoc.category).unitM;
      const cx = Math.floor(world.x);
      const cy = Math.floor(world.y);
      const gx = Math.floor(world.x / unitM);
      const gy = Math.floor(world.y / unitM);
      const simTag = curSim ? `${curSim.errorCount}:${curSim.warnCount}:${curShowIo ? 1 : 0}` : '0';
      const key = vm === 'building' ? `b:${curLang}:${fl}:${cx},${cy}:${simTag}` : `m:${curLang}:${fl}:${gx},${gy}`;

      const tipW = 264;
      const tipH = 74;
      const tx = clientX + 16 + tipW > window.innerWidth ? Math.max(8, clientX - tipW - 12) : clientX + 16;
      const ty = clientY + 18 + tipH > window.innerHeight ? Math.max(8, clientY - tipH - 10) : clientY + 18;

      if (key === lastHoverTipKeyRef.current) {
        if (el.style.display !== 'none') {
          el.style.transform = `translate3d(${Math.round(tx)}px, ${Math.round(ty)}px, 0)`;
        }
        return;
      }
      lastHoverTipKeyRef.current = key;

      if (vm === 'building') {
        const hit = findBuildingAtCell(curDoc, cx, cy, fl);
        if (!hit) {
          el.style.display = 'none';
          return;
        }
        const def = getBuildableDef(hit.type);
        const titleParts: string[] = [getShortLabel(hit.type, curLang === 'en' ? def?.nameEn : def?.nameZh, curLang)];
        if (def?.kind === 'underground') {
          titleParts.push(hit.undergroundMode === 'out' ? 'OUT' : 'IN');
        }
        if (hit.recipeId) {
          const rec = getRecipeDef(hit.recipeId);
          if (rec) titleParts.push(`· ${getRecipeName(rec, curLang)}`);
        }
        if (hit.label) titleParts.push(`[${hit.label}]`);

        let subText = '';
        let noteText = '';
        let tone: 'normal' | 'warn' | 'error' = 'normal';

        if (curSim) {
          const cellInfo = curSim.getCellItem(fl, cx, cy);
          if (cellInfo) {
            if (cellInfo.items.length > 0) {
              const names =
                cellInfo.items
                  .slice(0, 2)
                  .map((itemId) => getItemName(itemId, curLang))
                  .join(' + ') + (cellInfo.items.length > 2 ? '…' : '');
              subText = `${names} · Mk.${cellInfo.tier} (${cellInfo.capacity}/s)`;
              if (cellInfo.mixed) tone = 'warn';
            } else {
              subText =
                curLang === 'en'
                  ? `Empty · Mk.${cellInfo.tier} (${cellInfo.capacity}/s)`
                  : `空带 · Mk.${cellInfo.tier} (${cellInfo.capacity}/s)`;
            }
          }
          const fault = curSim.faults.find(
            (i) => i.floor === fl && ((i.x === cx && i.y === cy) || i.buildingId === hit.id)
          );
          if (fault) {
            noteText = fault.message;
            tone = fault.severity === 'error' ? 'error' : 'warn';
          } else if (curShowIo) {
            const spot = curSim.ioSpots.find(
              (s) => s.floor === fl && ((s.x === cx && s.y === cy) || s.buildingId === hit.id)
            );
            if (spot) noteText = spot.message;
          }
        }

        if (!subText && def) {
          const specs: string[] = [];
          const [bw, bd] = getBuildingSizeCells(def, hit.rotation);
          if (bw > 1 || bd > 1) {
            specs.push(`${bw}×${bd}`);
          }
          if (def.kind === 'belt' || def.kind === 'underground' || def.kind === 'splitter' || def.kind === 'balancer') {
            const spd = def.tier === 3 ? 3 : def.tier === 2 ? 2 : 1;
            specs.push(`Mk.${def.tier} · ${spd}/s`);
          }
          if (def.powerKW && def.powerKW > 0) specs.push(`${+(def.powerKW / 1000).toFixed(1)} MW`);
          if (hit.portFilters && Object.keys(hit.portFilters).length > 0) {
            const firstItem = Object.values(hit.portFilters)[0];
            specs.push(`${curLang === 'en' ? 'Filter' : '过滤'} ${getItemName(firstItem, curLang)}`);
          } else if (hit.filterItems && hit.filterItems.length > 0) {
            specs.push(curLang === 'en' ? `${hit.filterItems.length} filters` : `过滤 ${hit.filterItems.length}项`);
          }
          subText = specs.join(' · ');
        }

        if (hoverTitleRef.current) hoverTitleRef.current.textContent = titleParts.join(' ');
        if (hoverSubRef.current) {
          hoverSubRef.current.textContent = subText;
          hoverSubRef.current.style.display = subText ? 'block' : 'none';
        }
        if (hoverNoteRef.current) {
          hoverNoteRef.current.textContent = noteText;
          hoverNoteRef.current.style.display = noteText ? 'block' : 'none';
        }
        el.dataset.tone = tone;
        el.style.display = 'flex';
        el.style.transform = `translate3d(${Math.round(tx)}px, ${Math.round(ty)}px, 0)`;
        return;
      }

      // Station View hover inspection (O(1) spatial lookup)
      const hitMod = findModuleAtWorldPoint(curDoc, world.x, world.y, fl);
      if (!hitMod) {
        el.style.display = 'none';
        return;
      }
      const mDef = getModuleDef(hitMod.type);
      const titleParts: string[] = [getShortLabel(hitMod.type, curLang === 'en' ? mDef?.nameEn : mDef?.nameZh, curLang)];
      if (hitMod.recipeId) {
        const rec = getRecipeDef(hitMod.recipeId);
        if (rec) titleParts.push(`· ${getRecipeName(rec, curLang)}`);
      }
      if (hitMod.label) titleParts.push(`[${hitMod.label}]`);

      const subParts: string[] = [];
      if (mDef) {
        const [wu, du, hu] = getModuleSizeUnits(mDef, hitMod.rotation);
        subParts.push(`${wu}×${du}${hu > 1 ? (curLang === 'en' ? `×${hu}F` : `×${hu}层`) : ''}`);
        subParts.push(formatFloorTag(hitMod.floor));
        if (mDef.powerGenKW && mDef.powerGenKW > 0) subParts.push(`+${+(mDef.powerGenKW / 1000).toFixed(1)} MW`);
        else if (mDef.powerKW && mDef.powerKW > 0) subParts.push(`-${+(mDef.powerKW / 1000).toFixed(1)} MW`);
      }

      if (hoverTitleRef.current) hoverTitleRef.current.textContent = titleParts.join(' ');
      if (hoverSubRef.current) {
        hoverSubRef.current.textContent = subParts.join(' · ');
        hoverSubRef.current.style.display = subParts.length > 0 ? 'block' : 'none';
      }
      if (hoverNoteRef.current) {
        hoverNoteRef.current.textContent = '';
        hoverNoteRef.current.style.display = 'none';
      }
      el.dataset.tone = 'normal';
      el.style.display = 'flex';
      el.style.transform = `translate3d(${Math.round(tx)}px, ${Math.round(ty)}px, 0)`;
    },
    [hideHoverTip]
  );

  useEffect(() => {
    if (activeTool.kind !== 'select') hideHoverTip();
  }, [activeTool.kind, hideHoverTip]);

  const updateBoxBadge = useCallback(
    (
      visible: boolean,
      clientX = 0,
      clientY = 0,
      text = '',
      mode: BoxSelectMode = 'replace'
    ) => {
      const el = boxBadgeRef.current;
      if (!el) return;
      if (!visible) {
        el.style.display = 'none';
        return;
      }
      el.style.display = 'inline-flex';
      el.style.transform = `translate3d(${Math.round(clientX + 16)}px, ${Math.round(clientY + 16)}px, 0)`;
      el.dataset.mode = mode;
      el.textContent = text;
    },
    []
  );

  const updateLiveCursor = useCallback((world: { x: number; y: number } | null) => {
    cursorWorldRef.current = world;
    if (stateRef.current.cleanView) {
      sceneRef.current?.setCursorWorld(null);
      return;
    }
    sceneRef.current?.setCursorWorld(world);
    const cellKey = world ? `${Math.floor(world.x)},${Math.floor(world.y)}` : 'null';
    if (cellKey !== lastHudCellRef.current) {
      lastHudCellRef.current = cellKey;
      if (hudCoordRef.current) {
        hudCoordRef.current.textContent = world
          ? `X ${Math.floor(world.x)}  Y ${Math.floor(world.y)}`
          : 'X --  Y --';
      }
      if (hudGridRef.current) {
        const unitM = getFrameGridSpec(stateRef.current.doc.category).unitM;
        hudGridRef.current.textContent = world
          ? `G(${Math.floor(world.x / unitM)},${Math.floor(world.y / unitM)})`
          : 'G(-,-)';
      }
    }
  }, []);

  const [saveDialog, setSaveDialog] = useState<{
    mode: 'workspace' | 'selection';
    docToSave: BlueprintDocument;
    folder: string;
    name: string;
  } | null>(null);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const viewportRectRef = useRef<{ left: number; top: number; width: number; height: number } | null>(null);
  const sceneRef = useRef<CadSceneController | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const stateRef = useRef({
    doc,
    viewMode,
    focusFloor,
    hideAbove,
    cleanView,
    shipFreeRotate,
    selection,
    selectionLayerMode,
    activeTool,
    lastGroupMember,
    clipboardBp,
    simReport,
    showIoSpots,
    activeSimIssueId,
    lang,
  });
  stateRef.current = {
    doc,
    viewMode,
    focusFloor,
    hideAbove,
    cleanView,
    shipFreeRotate,
    selection,
    selectionLayerMode,
    activeTool,
    lastGroupMember,
    clipboardBp,
    simReport,
    showIoSpots,
    activeSimIssueId,
    lang,
  };

  const dragRef = useRef<{
    kind: 'none' | 'orbit' | 'pan' | 'clean-orbit' | 'box-select' | 'box-demolish' | 'shift-place-or-box' | 'demolish';
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    moved: boolean;
    startWorld: { x: number; y: number } | null;
    boxModifier: BoxSelectMode;
    liveSelection: SelectionState | null;
    sweepCommitted: boolean;
    sweepModCount: number;
    sweepBldCount: number;
  }>({
    kind: 'none',
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    moved: false,
    startWorld: null,
    boxModifier: 'replace',
    liveSelection: null,
    sweepCommitted: false,
    sweepModCount: 0,
    sweepBldCount: 0,
  });

  const setBeltPreviewSync = useCallback((specs: BeltCellSpec[]) => {
    beltPreviewRef.current = specs;
    setBeltPreview(specs);
  }, []);

  const syncBeltHudFlags = useCallback(() => {
    const s = beltSessionRef.current;
    if (!s) {
      setBeltHudFlags((prev) => (prev.tunnel || prev.reverse ? { tunnel: false, reverse: false } : prev));
      return;
    }
    const tunnel =
      s.mode === 'plan'
        ? s.planTunnel
        : s.strokeTunnels.length > 0 && s.strokeTunnels[s.strokeTunnels.length - 1].outIndex === null;
    const reverse = s.reverse;
    setBeltHudFlags((prev) => (prev.tunnel === tunnel && prev.reverse === reverse ? prev : { tunnel, reverse }));
  }, []);

  const clearBeltSession = useCallback(() => {
    if (beltSessionRef.current !== null) {
      beltSessionRef.current = null;
      setBeltSessionMode(null);
    }
    setBeltHudFlags((prev) => (prev.tunnel || prev.reverse ? { tunnel: false, reverse: false } : prev));
    if (beltPreviewRef.current.length > 0) {
      beltPreviewRef.current = [];
      setBeltPreview([]);
    }
  }, []);

  const computeBeltSessionSpecs = useCallback(
    (targetCell?: [number, number]): BeltCellSpec[] => {
      const session = beltSessionRef.current;
      if (!session) return [];
      const tool = stateRef.current.activeTool;
      const fallback = tool.kind === 'place-building' ? tool.rotation : 0;
      const endCell = targetCell ?? session.lastCursorCell;
      if (session.mode === 'plan') {
        return buildMultiWaypointBeltPath(
          stateRef.current.doc,
          session.floor,
          session.waypoints,
          endCell,
          {
            currentFlipCorner: session.flipCorner,
            reverse: session.reverse,
            fallbackRotation: fallback,
            tunnelObstacles: session.planTunnel,
            endRotation: session.endRotation,
          }
        );
      }
      return buildBeltStrokeSpecs(
        session.strokeCells,
        session.strokeTunnels,
        fallback,
        session.reverse,
        session.endRotation
      );
    },
    []
  );

  const refreshBeltSessionPreview = useCallback(
    (targetCell?: [number, number]) => {
      const specs = computeBeltSessionSpecs(targetCell);
      setBeltPreviewSync(specs);
      syncBeltHudFlags();
      return specs;
    },
    [computeBeltSessionSpecs, setBeltPreviewSync, syncBeltHudFlags]
  );

  useEffect(() => {
    const isBeltTool =
      activeTool.kind === 'place-building' && getBuildableDef(activeTool.buildingType)?.kind === 'belt';
    if (!isBeltTool || viewMode !== 'building') {
      clearBeltSession();
    } else if (beltSessionRef.current && beltSessionRef.current.floor !== focusFloor) {
      clearBeltSession();
    }
  }, [activeTool, viewMode, focusFloor, clearBeltSession]);

  const spaceHeldRef = useRef(false);

  const showToast = useCallback((text: string, kind: 'info' | 'warn' | 'error' = 'info') => {
    setToast({ text, kind });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  const enterCleanView = useCallback(() => {
    setPrefsMenuOpen(false);
    setLibraryModalOpen(false);
    setHelpOpen(false);
    hideHoverTip();
    updateBoxBadge(false);
    pendingPointerRef.current = null;
    sceneRef.current?.setCursorWorld(null);
    setCleanView(true);
    showToast(
      stateRef.current.lang === 'en'
        ? 'Clean View · Drag to orbit / pan · Click or Esc to exit'
        : '无 UI 预览 · 拖拽旋转/平移 · 点按画布或 Esc 退出'
    );
  }, [hideHoverTip, showToast, updateBoxBadge]);

  const exitCleanView = useCallback(() => {
    setCleanView(false);
  }, []);

  const commitDoc = useCallback((next: BlueprintDocument) => {
    setHistory((h) => commitHistory(h, next));
    setDirty(true);
  }, []);

  const refreshLibrary = useCallback(
    async (targetDriver?: BlueprintLibraryDriver, notify = false) => {
      const drv = targetDriver ?? driver;
      try {
        const nodes = await drv.listTree();
        setLibraryTree(nodes);
        if (notify) showToast('已刷新蓝图库');
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
    let idleId: number | null = null;
    let timer: number | null = null;
    const isHugeDirty = dirty && doc.buildings.length > 5000;
    const scheduleSave = (delayMs: number) => {
      timer = window.setTimeout(() => {
        timer = null;
        // Never interrupt an active drag (orbit / pan / box-select / sweep-demolish) with synchronous localStorage write!
        if (dragRef.current.kind !== 'none') {
          scheduleSave(1500);
          return;
        }
        const runSave = () => {
          idleId = null;
          if (dragRef.current.kind !== 'none') {
            scheduleSave(1500);
            return;
          }
          try {
            const ts = saveWorkspaceAutosave(doc, activeSourcePath, dirty);
            setLastAutosaveAt(ts);
          } catch {
            // Ignore storage quota errors without claiming file saved
          }
        };
        const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
          .requestIdleCallback;
        if (typeof ric === 'function') {
          idleId = ric(runSave, { timeout: 2000 });
        } else {
          runSave();
        }
      }, delayMs);
    };
    scheduleSave(isHugeDirty ? 3500 : 1800);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      if (idleId !== null) {
        const cic = (window as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
        if (typeof cic === 'function') cic(idleId);
      }
    };
  }, [doc, activeSourcePath, dirty]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ctrl = new CadSceneController(el, {
      onAutoViewModeChange: (nextMode) => {
        startTransition(() => {
          setViewMode(nextMode);
          setActiveTool((prev) => {
            if (nextMode === 'station' && prev.kind === 'place-building') return { kind: 'select' };
            if (nextMode === 'building' && prev.kind === 'place-module') return { kind: 'select' };
            return prev;
          });
        });
      },
      onTelemetryChange: (info) => {
        if (hudCamRef.current) {
          hudCamRef.current.textContent = `${info.yawDeg}°/${info.pitchDeg}° · ${info.distance}m`;
        }
      },
    });
    sceneRef.current = ctrl;

    const updateViewportRect = () => {
      const rect = el.getBoundingClientRect();
      viewportRectRef.current = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    };
    updateViewportRect();
    const ro = new ResizeObserver(() => {
      updateViewportRect();
      ctrl.resize();
    });
    ro.observe(el);
    window.addEventListener('resize', updateViewportRect);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', updateViewportRect);
      viewportRectRef.current = null;
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
      selection: cleanView ? EMPTY_SELECTION : selection,
      selectionLayerMode,
      activeTool: cleanView ? { kind: 'select' } : activeTool,
      cursorWorld: cleanView ? null : cursorWorldRef.current,
      beltPreview: cleanView ? [] : beltPreview,
      boxSelectRect: null,
      forceReplaceHeld: cleanView ? false : forceReplaceHeld,
      simulationIssues: cleanView ? undefined : simOverlayIssues,
    });
  }, [
    doc,
    theme,
    viewMode,
    focusFloor,
    hideAbove,
    cleanView,
    selection,
    selectionLayerMode,
    activeTool,
    beltPreview,
    forceReplaceHeld,
    simOverlayIssues,
  ]);

  const switchViewMode = useCallback((nextMode: ViewMode, focusCenter?: [number, number]) => {
    if (stateRef.current.doc.category === 'ship' && nextMode === 'building') {
      return;
    }
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
      if (curDoc.category === 'ship') {
        rig.focusPoint(4, 4, 42);
      } else {
        rig.focusPoint(16, 16, 76);
      }
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

      const res = deleteSelectionCmd(curDoc, sel, { cascadeBuildingsInModules: true });
      if (!res.changed) return;

      const removedMods = curDoc.modules.length - res.doc.modules.length;
      const removedBlds = curDoc.buildings.length - res.doc.buildings.length;
      commitDoc(res.doc);
      setSelection(EMPTY_SELECTION);

      if (removedMods > 0 && removedBlds > 0) {
        showToast(`已拆除 ${removedMods} 个模块及内部 ${removedBlds} 台建筑（Ctrl+Z 撤销）`);
      } else if (removedMods > 0) {
        showToast(`已拆除 ${removedMods} 个模块（Ctrl+Z 撤销）`);
      } else if (removedBlds > 1) {
        showToast(`已拆除 ${removedBlds} 台建筑（Ctrl+Z 撤销）`);
      }
    },
    [commitDoc, showToast]
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
      setActiveTool({
        kind: 'stamp-blueprint',
        blueprint: bp,
        name: bp.name,
        rotation: 0,
        floorOffset: 0,
        fromCut: cut,
      });
      if (cut) {
        const del = deleteSelectionCmd(curDoc, sel, { cascadeBuildingsInModules: true });
        if (del.changed) {
          commitDoc(del.doc);
          setSelection(EMPTY_SELECTION);
        }
        showToast('已剪切搬移（左键落位 / R旋转 / M镜像 / Q/E切层 / Ctrl+Z可撤销）');
      } else {
        showToast('已复制为幽灵蓝图（左键连续盖章 / R旋转 / M镜像 / 右键放下）');
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
      clearBeltSession();
      const modDef = getModuleDef(entityId);
      if (modDef) {
        const docCat = stateRef.current.doc.category ?? 'station';
        const grp = findGroupForEntity('station', entityId, docCat);
        if (grp) setLastGroupMember((prev) => ({ ...prev, [grp.id]: entityId }));
        const lockOrient =
          docCat === 'ship' && !stateRef.current.shipFreeRotate && modDef.canRotate === false;
        setActiveTool((prev) => ({
          kind: 'place-module',
          moduleType: entityId,
          rotation: lockOrient ? 0 : opts?.rotation ?? (prev.kind === 'place-module' ? prev.rotation : 0),
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
    [clearBeltSession]
  );

  const applyMirrorAction = useCallback(
    (vertical = false) => {
      const axis = sceneRef.current?.rig.getScreenMirrorAxis(vertical) ?? (vertical ? 'y' : 'x');
      const dirZh = vertical ? '垂直' : '水平';
      const dirEn = vertical ? 'vertically' : 'horizontally';
      const { activeTool: tool, doc: curDoc, selection: sel } = stateRef.current;

      if (tool.kind === 'stamp-blueprint') {
        setActiveTool({ ...tool, blueprint: mirrorBlueprint(tool.blueprint, axis) });
        showToast(t(`已${dirZh}镜像蓝图`, `Mirrored blueprint ${dirEn}`));
        return;
      }

      if (tool.kind === 'place-module') {
        const def = getModuleDef(tool.moduleType);
        // Native MirrorClass swap (covers all 11 ship mirror pairs & station armour top/bottom!)
        if (def?.mirrorId) {
          const mirrorDef = getModuleDef(def.mirrorId);
          selectEntityTool(def.mirrorId, { rotation: tool.rotation, label: tool.label });
          showToast(
            t(
              `已镜像为 ${mirrorDef ? getModuleName(mirrorDef, 'zh') : def.mirrorId}`,
              `Mirrored to ${mirrorDef ? getModuleName(mirrorDef, 'en') : def.mirrorId}`
            )
          );
          return;
        }
        if (tool.moduleType === 'BPO_StationArmour_01' || tool.moduleType === 'BPO_StationArmour_01B') {
          const flipped =
            tool.moduleType === 'BPO_StationArmour_01' ? 'BPO_StationArmour_01B' : 'BPO_StationArmour_01';
          selectEntityTool(flipped, { rotation: tool.rotation, label: tool.label });
          showToast(
            flipped === 'BPO_StationArmour_01'
              ? t('已翻转为顶面装甲', 'Flipped to top armour')
              : t('已翻转为底面装甲', 'Flipped to bottom armour')
          );
          return;
        }
        if (curDoc.category === 'ship' && !stateRef.current.shipFreeRotate && def?.canRotate === false) {
          showToast(t('该飞船部件无原版镜像', 'No native mirror for this ship block'), 'info');
          return;
        }
        const nextRot = getMirroredModuleRotation(def, tool.rotation, axis);
        if (nextRot !== tool.rotation) {
          setActiveTool({ ...tool, rotation: nextRot });
          showToast(t(`已${dirZh}镜像模块`, `Mirrored module ${dirEn}`));
        }
        return;
      }

      if (tool.kind === 'place-building') {
        const def = getBuildableDef(tool.buildingType);
        const nextRot = getMirroredBuildingRotation(def, tool.rotation, axis);
        const remapped = mirrorBuildingPortConfig(def, tool.rotation, nextRot, axis, {
          disabledPorts: tool.disabledPorts,
          priorityIn: tool.priorityIn,
          priorityOut: tool.priorityOut,
          portFilters: tool.portFilters,
        });
        setActiveTool({
          ...tool,
          rotation: nextRot,
          disabledPorts: remapped.disabledPorts,
          priorityIn: remapped.priorityIn,
          priorityOut: remapped.priorityOut,
          portFilters: remapped.portFilters,
        });
        showToast(t(`已${dirZh}镜像建筑`, `Mirrored building ${dirEn}`));
        return;
      }

      if (sel.moduleIds.length > 0 || sel.buildingIds.length > 0) {
        const res = mirrorSelectionInPlaceCmd(curDoc, sel, axis);
        if (res.changed) {
          commitDoc(res.doc);
          showToast(t(`已${dirZh}镜像选中项`, `Mirrored selection ${dirEn}`));
        } else if (res.message) {
          showToast(
            t(
              `无法原地镜像：${res.message}（可先 Ctrl+X 剪切后按 F 镜像）`,
              `Cannot mirror in place: ${res.message} (use Ctrl+X then F)`
            ),
            'warn'
          );
        }
      }
    },
    [commitDoc, selectEntityTool, showToast, t]
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
    if (beltSessionRef.current) {
      clearBeltSession();
      return;
    }
    const { activeTool: tool, selection: sel } = stateRef.current;
    if (tool.kind !== 'select') {
      setActiveTool({ kind: 'select' });
      setStampingLibPath(null);
      clearBeltSession();
      return;
    }
    if (sel.moduleIds.length > 0 || sel.buildingIds.length > 0) {
      setSelection(EMPTY_SELECTION);
    }
  }, [clearBeltSession]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceHeldRef.current = true;
      if (e.key === 'Shift') setForceReplaceHeld(true);

      // Universal Esc close (works even while focused in search / text inputs!)
      if (e.key === 'Escape') {
        e.preventDefault();
        if (stateRef.current.cleanView) {
          exitCleanView();
          return;
        }
        if (beltSessionRef.current) {
          clearBeltSession();
          return;
        }
        if (dragRef.current.kind === 'box-select' || dragRef.current.kind === 'box-demolish' || dragRef.current.kind === 'shift-place-or-box') {
          dragRef.current.kind = 'none';
          dragRef.current.moved = false;
          dragRef.current.liveSelection = null;
          pendingPointerRef.current = null;
          sceneRef.current?.setLiveBoxSelect(null);
          updateBoxBadge(false);
          return;
        }
        if (ghModal && !ghModal.busy) { setGhModal(null); return; }
        if (saveDialog) { setSaveDialog(null); return; }
        if (helpOpen) { setHelpOpen(false); return; }
        if (libraryModalOpen) { setLibraryModalOpen(false); return; }
        if (prefsMenuOpen) { setPrefsMenuOpen(false); return; }
        const { activeTool: curTool, selection: curSel } = stateRef.current;
        if (curTool.kind !== 'select' || curSel.moduleIds.length > 0 || curSel.buildingIds.length > 0) {
          handleCancelAction();
          return;
        }
        if (simOpen) {
          setSimOpen(false);
          setActiveSimIssueId(null);
        }
        return;
      }

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

      if (stateRef.current.cleanView) {
        if (lower === 'h') {
          e.preventDefault();
          exitCleanView();
        } else if (lower === 'e') {
          e.preventDefault();
          setFocusFloor((f) => Math.min(8, f + 1));
        } else if (lower === 'q') {
          e.preventDefault();
          setFocusFloor((f) => Math.max(-2, f - 1));
        } else if (lower === 'v') {
          e.preventDefault();
          setHideAbove((v) => !v);
        } else if (e.key === 'Home') {
          e.preventDefault();
          fitAllStation();
        }
        return;
      }

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

      if (lower === 'l') {
        e.preventDefault();
        setLibraryModalOpen((o) => !o);
        return;
      }
      if (e.code === 'Backquote') {
        e.preventDefault();
        if (stateRef.current.doc.category === 'ship') return;
        switchViewMode(stateRef.current.viewMode === 'station' ? 'building' : 'station');
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const { activeTool: tool, viewMode: vm, doc: curDoc } = stateRef.current;
        const docCat = curDoc.category ?? 'station';
        const delta: 1 | -1 = e.shiftKey ? -1 : 1;
        if (tool.kind === 'place-module' && (vm === 'station' || docCat === 'ship')) {
          const next = cycleVariantInGroup('station', tool.moduleType, delta, docCat);
          if (next) selectEntityTool(next);
          return;
        }
        if (tool.kind === 'place-building' && vm === 'building' && docCat !== 'ship') {
          const next = cycleVariantInGroup('building', tool.buildingType, delta, 'station');
          if (next) selectEntityTool(next);
          return;
        }
        if (docCat !== 'ship') {
          switchViewMode(vm === 'station' ? 'building' : 'station');
        }
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
      if (lower === 'h') {
        e.preventDefault();
        enterCleanView();
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
        if (e.shiftKey) focusSelection();
        else fitAllStation();
        return;
      }
      if (lower === 'f' || lower === 'm') {
        e.preventDefault();
        const session = beltSessionRef.current;
        if (session) {
          if (lower === 'f' && session.mode === 'plan') {
            session.flipCorner = !session.flipCorner;
            refreshBeltSessionPreview();
          }
          return;
        }
        applyMirrorAction(e.shiftKey);
        return;
      }
      if (lower === 'x') {
        e.preventDefault();
        setActiveTool((t) => (t.kind === 'demolish' ? { kind: 'select' } : { kind: 'demolish' }));
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        const session = beltSessionRef.current;
        if (session) {
          if (e.key === 'Delete') {
            clearBeltSession();
            return;
          }
          if (session.mode === 'plan') {
            if (session.waypoints.length > 1) {
              session.waypoints.pop();
              session.flipCorner = session.waypoints[session.waypoints.length - 1].flipCorner;
              session.endRotation = null;
              refreshBeltSessionPreview();
            } else {
              clearBeltSession();
            }
            return;
          }
          if (session.strokeCells.length > 1) {
            session.strokeCells = session.strokeCells.slice(0, -1);
            const len = session.strokeCells.length;
            session.strokeTunnels = session.strokeTunnels
              .filter((tn) => tn.inIndex < len)
              .map((tn) => (tn.outIndex !== null && tn.outIndex >= len ? { inIndex: tn.inIndex, outIndex: null } : tn));
            session.endRotation = null;
            refreshBeltSessionPreview();
          } else {
            clearBeltSession();
          }
          return;
        }
        requestDeleteSelection(stateRef.current.selection);
        return;
      }
      if (lower === 'r') {
        e.preventDefault();
        const delta: 1 | -1 = e.shiftKey ? -1 : 1;
        const session = beltSessionRef.current;
        if (session) {
          const tool = stateRef.current.activeTool;
          const fallback = tool.kind === 'place-building' ? tool.rotation : 0;
          const curSpecs = beltPreviewRef.current;
          const curLast = curSpecs.length > 0 ? curSpecs[curSpecs.length - 1] : undefined;
          if (curLast?.kind === 'underground-in' || curLast?.kind === 'underground-out') {
            return;
          }
          const baseRot = curLast?.rotation ?? session.endRotation ?? fallback;
          session.endRotation = stepBeltEndRotation(curSpecs, baseRot, delta);
          refreshBeltSessionPreview();
          return;
        }
        const { activeTool: tool, doc: curDoc, shipFreeRotate: freeRot, selection: curSel } = stateRef.current;
        if (tool.kind === 'place-module') {
          if (curDoc.category === 'ship' && !canModuleRotate(tool.moduleType, freeRot)) {
            showToast(
              t(
                '原版锁定朝向（按 F 镜像，或在「视角」开启自由旋转）',
                'Orientation locked (F to mirror, or enable Free Rotate in View)'
              ),
              'info'
            );
            return;
          }
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
          if (curDoc.category === 'ship' && !freeRot && curSel.moduleIds.length > 0) {
            const hasLocked = curSel.moduleIds.some((mid) => {
              const m = curDoc.modules.find((x) => x.id === mid);
              return m ? !canModuleRotate(m.type, false) : false;
            });
            if (hasLocked) {
              showToast(
                t(
                  '选区含原版锁定朝向部件（可在「视角」开启自由旋转）',
                  'Selection includes orientation-locked blocks (enable Free Rotate in View)'
                ),
                'info'
              );
              return;
            }
          }
          const res = rotateSelectionInPlaceCmd(curDoc, curSel, delta);
          if (res.changed) commitDoc(res.doc);
        }
        return;
      }
      if (e.key === 'Alt' && beltSessionRef.current) {
        e.preventDefault();
        beltSessionRef.current.reverse = !beltSessionRef.current.reverse;
        refreshBeltSessionPreview();
        return;
      }
      if (lower === 't') {
        const session = beltSessionRef.current;
        if (session?.mode === 'stroke') {
          e.preventDefault();
          const res = toggleBeltStrokeTunnel(session.strokeCells, session.strokeTunnels);
          session.strokeTunnels = res.tunnels;
          refreshBeltSessionPreview();
          showToast(
            res.action === 'dive'
              ? t('地下带潜入（再按 T 钻出）', 'Tunnel dive (T to surface)')
              : res.action === 'surface'
                ? t('地下带钻出', 'Tunnel surfaced')
                : t('已取消地下带潜入', 'Tunnel dive cancelled')
          );
          return;
        }
        if (session?.mode === 'plan') {
          e.preventDefault();
          session.planTunnel = !session.planTunnel;
          refreshBeltSessionPreview();
          showToast(
            session.planTunnel
              ? t('跨障地下带：开', 'Auto tunnel: ON')
              : t('跨障地下带：关', 'Auto tunnel: OFF')
          );
          return;
        }
        const tool = stateRef.current.activeTool;
        if (tool.kind === 'place-building') {
          const ugId = getMatchingUndergroundType(tool.buildingType);
          if (ugId) {
            e.preventDefault();
            selectEntityTool(ugId, { rotation: tool.rotation, undergroundMode: 'in' });
            showToast(t(`地下带：${getShortLabel(ugId, undefined, lang)}`, `Tunnel: ${getShortLabel(ugId, undefined, lang)}`));
            return;
          }
          const beltId = getMatchingBeltType(tool.buildingType);
          if (beltId) {
            e.preventDefault();
            selectEntityTool(beltId, { rotation: tool.rotation });
            showToast(t(`传送带：${getShortLabel(beltId, undefined, lang)}`, `Belt: ${getShortLabel(beltId, undefined, lang)}`));
            return;
          }
        }
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
        if (cursorWorldRef.current) pipetteAtWorld(cursorWorldRef.current);
        return;
      }

      if (/^[1-9]$/.test(e.key)) {
        const slot = Number(e.key);
        const { viewMode: vm, activeTool: tool, lastGroupMember: mem, doc: curDoc } = stateRef.current;
        const docCat = curDoc.category ?? 'station';
        const group = getGroupsForView(vm, docCat).find((g) => g.slot === slot);
        if (!group) return;
        const curId =
          (vm === 'station' || docCat === 'ship') && tool.kind === 'place-module'
            ? tool.moduleType
            : vm === 'building' && tool.kind === 'place-building'
              ? tool.buildingType
              : null;
        const curDef = curId ? getModuleDef(curId) : undefined;
        const inGroup = Boolean(
          curId && (group.members.includes(curId) || (curDef?.mirrorId && group.members.includes(curDef.mirrorId)))
        );
        if (curId && inGroup && group.members.length > 1) {
          const next = cycleVariantInGroup(vm, curId, e.shiftKey ? -1 : 1, docCat);
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
      pendingPointerRef.current = null;
      dragRef.current.kind = 'none';
      dragRef.current.moved = false;
      sceneRef.current?.clearKeys();
      sceneRef.current?.setCameraDragging(false);
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
    applyMirrorAction,
    clearBeltSession,
    commitDoc,
    copySelectionToGhost,
    enterCleanView,
    exitCleanView,
    fitAllStation,
    focusSelection,
    ghModal,
    handleCancelAction,
    helpOpen,
    lang,
    libraryModalOpen,
    openSaveDialog,
    pipetteAtWorld,
    prefsMenuOpen,
    refreshBeltSessionPreview,
    requestDeleteSelection,
    saveDialog,
    selectEntityTool,
    showToast,
    simOpen,
    switchViewMode,
    t,
    updateBoxBadge,
  ]);

  const clientToWorld = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const ctrl = sceneRef.current;
    const rect = viewportRectRef.current;
    if (!ctrl || !rect || rect.width <= 0 || rect.height <= 0) return null;
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
    const hit = ctrl.rig.intersectFocusPlane(ndcX, ndcY);
    return hit ? { x: hit.x, y: hit.z } : null;
  }, []);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    hideHoverTip();

    if (stateRef.current.cleanView) {
      pendingPointerRef.current = null;
      if (e.button === 1 || (e.button === 0 && spaceHeldRef.current)) {
        sceneRef.current?.setCameraDragging(true);
        dragRef.current = {
          ...dragRef.current,
          kind: 'pan',
          startX: e.clientX,
          startY: e.clientY,
          lastX: e.clientX,
          lastY: e.clientY,
          moved: false,
          startWorld: null,
        };
      } else if (e.button === 0 || e.button === 2) {
        sceneRef.current?.setCameraDragging(true);
        dragRef.current = {
          ...dragRef.current,
          kind: 'clean-orbit',
          startX: e.clientX,
          startY: e.clientY,
          lastX: e.clientX,
          lastY: e.clientY,
          moved: false,
          startWorld: null,
        };
      }
      return;
    }

    if (e.button === 2) {
      pendingPointerRef.current = null;
      sceneRef.current?.setCameraDragging(true);
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
      pendingPointerRef.current = null;
      sceneRef.current?.setCameraDragging(true);
      dragRef.current = {
        ...dragRef.current,
        kind: 'pan',
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        moved: false,
        startWorld: null,
      };
      return;
    }

    const world = flushPendingPointer(e);
    if (e.button !== 0 || !world) return;
    const { doc: curDoc, viewMode: vm, focusFloor: fl, activeTool: tool } = stateRef.current;

    if (tool.kind === 'demolish') {
      if (e.shiftKey) {
        dragRef.current = {
          ...dragRef.current,
          kind: 'box-demolish',
          startX: e.clientX,
          startY: e.clientY,
          lastX: e.clientX,
          lastY: e.clientY,
          moved: false,
          startWorld: world,
          boxModifier: 'demolish',
          liveSelection: null,
          sweepCommitted: false,
          sweepModCount: 0,
          sweepBldCount: 0,
        };
        return;
      }
      dragRef.current = {
        ...dragRef.current,
        kind: 'demolish',
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        moved: false,
        sweepCommitted: false,
        sweepModCount: 0,
        sweepBldCount: 0,
      };
      if (vm === 'building') {
        const b = findBuildingAtCell(curDoc, Math.floor(world.x), Math.floor(world.y), fl);
        if (b) {
          const res = deleteSelectionCmd(curDoc, { moduleIds: [], buildingIds: [b.id] });
          if (res.changed) {
            stateRef.current.doc = res.doc;
            commitDoc(res.doc);
            dragRef.current.sweepCommitted = true;
            dragRef.current.sweepBldCount = 1;
          }
        }
      } else {
        const m = findModuleAtWorldPoint(curDoc, world.x, world.y, fl);
        if (m) {
          const res = deleteSelectionCmd(curDoc, { moduleIds: [m.id], buildingIds: [] }, { cascadeBuildingsInModules: true });
          if (res.changed) {
            const rmBlds = curDoc.buildings.length - res.doc.buildings.length;
            stateRef.current.doc = res.doc;
            commitDoc(res.doc);
            dragRef.current.sweepCommitted = true;
            dragRef.current.sweepModCount = 1;
            dragRef.current.sweepBldCount = rmBlds;
          }
        }
      }
      return;
    }

    if (tool.kind === 'place-module') {
      if (e.shiftKey) {
        dragRef.current = {
          ...dragRef.current,
          kind: 'shift-place-or-box',
          startX: e.clientX,
          startY: e.clientY,
          lastX: e.clientX,
          lastY: e.clientY,
          moved: false,
          startWorld: world,
          boxModifier: 'replace',
          liveSelection: null,
        };
        return;
      }
      const unitM = getFrameGridSpec(curDoc.category).unitM;
      const gx = Math.floor(world.x / unitM);
      const gy = Math.floor(world.y / unitM);
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
        const existing = beltSessionRef.current;
        if (existing) {
          // Second click: commit entire planned/freehand belt path atomically!
          existing.lastCursorCell = cell;
          if (existing.mode === 'stroke') {
            const ext = extendBeltStrokeWithTunnels(existing.strokeCells, existing.strokeTunnels, cell);
            existing.strokeCells = ext.cells;
            existing.strokeTunnels = ext.tunnels;
          }
          const finalSpecs = computeBeltSessionSpecs(cell);
          if (finalSpecs.length > 0) {
            const res = placeBeltRunCmd(curDoc, tool.buildingType, fl, finalSpecs);
            if (res.changed) commitDoc(res.doc);
          }
          clearBeltSession();
          return;
        }
        // First click: start click-to-click routing (default = L-plan with waypoints; Shift+click = freehand stroke)
        const mode: 'plan' | 'stroke' = e.shiftKey ? 'stroke' : 'plan';
        beltSessionRef.current = {
          mode,
          floor: fl,
          waypoints: [{ cell, flipCorner: false }],
          flipCorner: false,
          planTunnel: false,
          strokeCells: [cell],
          strokeTunnels: [],
          reverse: e.altKey,
          endRotation: null,
          lastCursorCell: cell,
        };
        setBeltSessionMode(mode);
        refreshBeltSessionPreview(cell);
        return;
      }

      if (e.shiftKey) {
        dragRef.current = {
          ...dragRef.current,
          kind: 'shift-place-or-box',
          startX: e.clientX,
          startY: e.clientY,
          lastX: e.clientX,
          lastY: e.clientY,
          moved: false,
          startWorld: world,
          boxModifier: 'replace',
          liveSelection: null,
        };
        return;
      }

      const [w, d] = getBuildingSizeCells(def, tool.rotation);
      const bx = Math.floor(world.x - w / 2 + 0.5);
      const by = Math.floor(world.y - d / 2 + 0.5);
      const ugMode = def.kind === 'underground' ? (tool.undergroundMode ?? 'in') : undefined;
      const res = placeBuildingCmd(
        curDoc,
        {
          type: tool.buildingType,
          x: bx,
          y: by,
          floor: fl,
          rotation: tool.rotation,
          undergroundMode: ugMode,
          ...(def.kind === 'underground' && ugMode === 'out' && tool.pendingUndergroundInId
            ? { undergroundPartnerId: tool.pendingUndergroundInId }
            : {}),
          ...(tool.recipeId ? { recipeId: tool.recipeId } : {}),
          ...(tool.label ? { label: tool.label } : {}),
          ...(tool.disabledPorts && tool.disabledPorts.length > 0 ? { disabledPorts: [...tool.disabledPorts] } : {}),
          ...(tool.priorityIn !== undefined ? { priorityIn: tool.priorityIn } : {}),
          ...(tool.priorityOut !== undefined ? { priorityOut: tool.priorityOut } : {}),
          ...(tool.portFilters && Object.keys(tool.portFilters).length > 0 ? { portFilters: { ...tool.portFilters } } : {}),
          ...(tool.filterItems && tool.filterItems.length > 0 ? { filterItems: [...tool.filterItems] } : {}),
        },
        { allowForceReplace: false }
      );
      if (res.changed) {
        commitDoc(res.doc);
        if (def.kind === 'underground') {
          const nextMode = ugMode === 'out' ? 'in' : 'out';
          setActiveTool({
            ...tool,
            undergroundMode: nextMode,
            pendingUndergroundInId: ugMode === 'in' ? res.addedBuildingIds?.[0] : undefined,
          });
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
        if (tool.fromCut) {
          setActiveTool({ kind: 'select' });
          setStampingLibPath(null);
          showToast(`已搬移落位「${tool.name}」（仍可按 Ctrl+V 继续粘贴）`);
        } else {
          showToast(`已盖章粘贴「${tool.name}」`);
        }
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
      liveSelection: null,
    };
  };

  const processPointerMove = (e: PointerSample) => {
    const world = stateRef.current.cleanView ? null : clientToWorld(e.clientX, e.clientY);
    processedPointerWorldRef.current = world;
    if (world) updateLiveCursor(world);

    const d = dragRef.current;
    if (d.kind === 'none') {
      if (stateRef.current.cleanView) return;
      const session = beltSessionRef.current;
      if (session && world) {
        hideHoverTip();
        const cell: [number, number] = [Math.floor(world.x), Math.floor(world.y)];
        if (cell[0] !== session.lastCursorCell[0] || cell[1] !== session.lastCursorCell[1]) {
          session.lastCursorCell = cell;
          if (session.mode === 'stroke') {
            const ext = extendBeltStrokeWithTunnels(session.strokeCells, session.strokeTunnels, cell);
            if (ext.cells !== session.strokeCells || ext.tunnels !== session.strokeTunnels) {
              session.strokeCells = ext.cells;
              session.strokeTunnels = ext.tunnels;
              refreshBeltSessionPreview(cell);
            }
          } else {
            refreshBeltSessionPreview(cell);
          }
        }
        return;
      }
      updateHoverTip(world, e.clientX, e.clientY);
      return;
    }
    hideHoverTip();

    const dx = e.clientX - d.lastX;
    const dy = e.clientY - d.lastY;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) >= 5) {
      d.moved = true;
    }

    if (d.kind === 'orbit' || d.kind === 'clean-orbit') {
      sceneRef.current?.rig.orbitByPixels(dx, dy);
      return;
    }
    if (d.kind === 'pan') {
      const h = viewportRectRef.current?.height || 600;
      sceneRef.current?.rig.panByScreenDelta(dx, dy, h);
      return;
    }
    if (!world) return;

    // Shapez 2 ergonomics: Shift+drag from a build tool smoothly transitions into real-time area select!
    if (d.kind === 'shift-place-or-box' && d.moved) {
      d.kind = 'box-select';
      d.boxModifier = 'replace';
    }

    if ((d.kind === 'box-select' || d.kind === 'box-demolish') && d.moved && d.startWorld) {
      const rect = {
        minX: Math.min(d.startWorld.x, world.x),
        minY: Math.min(d.startWorld.y, world.y),
        maxX: Math.max(d.startWorld.x, world.x),
        maxY: Math.max(d.startWorld.y, world.y),
      };
      const { doc: curDoc, viewMode: vm, focusFloor: fl, selection: prevSel, hideAbove: ha, selectionLayerMode: slm } =
        stateRef.current;
      const hitSel = boxSelectEntities(curDoc, rect, { viewMode: vm, focusFloor: fl, hideAbove: ha, layerMode: slm });

      let effectiveSel: SelectionState;
      if (d.kind === 'box-demolish') {
        effectiveSel = hitSel;
      } else if (d.boxModifier === 'add') {
        effectiveSel = {
          moduleIds: Array.from(new Set([...prevSel.moduleIds, ...hitSel.moduleIds])),
          buildingIds: Array.from(new Set([...prevSel.buildingIds, ...hitSel.buildingIds])),
        };
      } else if (d.boxModifier === 'sub') {
        const rmM = new Set(hitSel.moduleIds);
        const rmB = new Set(hitSel.buildingIds);
        effectiveSel = {
          moduleIds: prevSel.moduleIds.filter((id) => !rmM.has(id)),
          buildingIds: prevSel.buildingIds.filter((id) => !rmB.has(id)),
        };
      } else {
        effectiveSel = hitSel;
      }

      d.liveSelection = effectiveSel;
      sceneRef.current?.setLiveBoxSelect(rect, d.boxModifier, effectiveSel);

      const mCnt = effectiveSel.moduleIds.length;
      const bCnt = effectiveSel.buildingIds.length;
      const countText =
        mCnt > 0 && bCnt > 0
          ? `${mCnt} 模 · ${bCnt} 建`
          : mCnt > 0
            ? `${mCnt} 模`
            : `${bCnt} 建`;
      const prefix =
        d.kind === 'box-demolish'
          ? '框选拆除'
          : d.boxModifier === 'add'
            ? '加选'
            : d.boxModifier === 'sub'
              ? '减选'
              : '框选';
      updateBoxBadge(true, e.clientX, e.clientY, `${prefix} ${countText}`, d.boxModifier);
      return;
    }

    if (d.kind === 'demolish') {
      const { doc: curDoc, viewMode: vm, focusFloor: fl } = stateRef.current;
      let res: ReturnType<typeof deleteSelectionCmd> | null = null;
      if (vm === 'building') {
        const b = findBuildingAtCell(curDoc, Math.floor(world.x), Math.floor(world.y), fl);
        if (b) res = deleteSelectionCmd(curDoc, { moduleIds: [], buildingIds: [b.id] });
      } else {
        const m = findModuleAtWorldPoint(curDoc, world.x, world.y, fl);
        if (m) res = deleteSelectionCmd(curDoc, { moduleIds: [m.id], buildingIds: [] }, { cascadeBuildingsInModules: true });
      }
      if (res && res.changed) {
        const rmMods = curDoc.modules.length - res.doc.modules.length;
        const rmBlds = curDoc.buildings.length - res.doc.buildings.length;
        stateRef.current.doc = res.doc;
        if (!d.sweepCommitted) {
          commitDoc(res.doc);
          d.sweepCommitted = true;
        } else {
          // Batch entire continuous sweep stroke into ONE atomic Ctrl+Z undo step!
          setHistory((h) => ({ ...h, present: res!.doc }));
          setDirty(true);
        }
        d.sweepModCount += rmMods;
        d.sweepBldCount += rmBlds;
      }
    }
  };

  const flushPendingPointer = (sample?: PointerSample): { x: number; y: number } | null => {
    if (sample) pendingPointerRef.current = { clientX: sample.clientX, clientY: sample.clientY };
    const pending = pendingPointerRef.current;
    if (!pending) return null;
    pendingPointerRef.current = null;
    processPointerMove(pending);
    return processedPointerWorldRef.current;
  };

  useEffect(() => {
    const ctrl = sceneRef.current;
    if (!ctrl) return;
    ctrl.setBeforeRender(() => {
      flushPendingPointer();
    });
    return () => ctrl.setBeforeRender(null);
  });

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (d.kind === 'orbit' || d.kind === 'clean-orbit' || d.kind === 'pan') {
      pendingPointerRef.current = null;
      const dx = e.clientX - d.lastX;
      const dy = e.clientY - d.lastY;
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) >= 5) d.moved = true;
      if (d.kind === 'pan') {
        const h = viewportRectRef.current?.height || 600;
        sceneRef.current?.rig.panByScreenDelta(dx, dy, h);
      } else {
        sceneRef.current?.rig.orbitByPixels(dx, dy);
      }
      return;
    }

    pendingPointerRef.current = { clientX: e.clientX, clientY: e.clientY };
    if (d.kind === 'demolish') flushPendingPointer();
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (d.kind === 'orbit' || d.kind === 'clean-orbit' || d.kind === 'pan') {
      sceneRef.current?.setCameraDragging(false);
    }
    const world = flushPendingPointer(e);

    if (d.kind === 'clean-orbit') {
      if (!d.moved) {
        exitCleanView();
      } else {
        sceneRef.current?.rig.snapAngles();
      }
    } else if (d.kind === 'orbit') {
      if (!d.moved) {
        handleCancelAction();
      } else {
        sceneRef.current?.rig.snapAngles();
      }
    } else if (d.kind === 'pan' && !d.moved && e.button === 1 && world && !stateRef.current.cleanView) {
      const session = beltSessionRef.current;
      if (session) {
        if (session.mode === 'plan') {
          const cell: [number, number] = [Math.floor(world.x), Math.floor(world.y)];
          const prevWp = session.waypoints[session.waypoints.length - 1];
          if (!prevWp || prevWp.cell[0] !== cell[0] || prevWp.cell[1] !== cell[1]) {
            if (prevWp) prevWp.flipCorner = session.flipCorner;
            session.waypoints.push({ cell, flipCorner: session.flipCorner });
            session.endRotation = null;
            session.lastCursorCell = cell;
            refreshBeltSessionPreview(cell);
          }
        }
      } else {
        pipetteAtWorld(world);
      }
    } else if (d.kind === 'shift-place-or-box' && !d.moved && world) {
      // Short Shift+Click while holding a module or machine -> perform force-replace placement!
      const { doc: curDoc, focusFloor: fl, activeTool: tool } = stateRef.current;
      if (tool.kind === 'place-module') {
        const unitM = getFrameGridSpec(curDoc.category).unitM;
        const gx = Math.floor(world.x / unitM);
        const gy = Math.floor(world.y / unitM);
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
      } else if (tool.kind === 'place-building') {
        const def = getBuildableDef(tool.buildingType);
        if (def) {
          const [w, dep] = getBuildingSizeCells(def, tool.rotation);
          const bx = Math.floor(world.x - w / 2 + 0.5);
          const by = Math.floor(world.y - dep / 2 + 0.5);
          const ugMode = def.kind === 'underground' ? (tool.undergroundMode ?? 'in') : undefined;
          const res = placeBuildingCmd(
            curDoc,
            {
              type: tool.buildingType,
              x: bx,
              y: by,
              floor: fl,
              rotation: tool.rotation,
              undergroundMode: ugMode,
              ...(def.kind === 'underground' && ugMode === 'out' && tool.pendingUndergroundInId
                ? { undergroundPartnerId: tool.pendingUndergroundInId }
                : {}),
              ...(tool.recipeId ? { recipeId: tool.recipeId } : {}),
              ...(tool.label ? { label: tool.label } : {}),
              ...(tool.disabledPorts && tool.disabledPorts.length > 0 ? { disabledPorts: [...tool.disabledPorts] } : {}),
              ...(tool.priorityIn !== undefined ? { priorityIn: tool.priorityIn } : {}),
              ...(tool.priorityOut !== undefined ? { priorityOut: tool.priorityOut } : {}),
              ...(tool.portFilters && Object.keys(tool.portFilters).length > 0 ? { portFilters: { ...tool.portFilters } } : {}),
              ...(tool.filterItems && tool.filterItems.length > 0 ? { filterItems: [...tool.filterItems] } : {}),
            },
            { allowForceReplace: true }
          );
          if (res.changed) {
            commitDoc(res.doc);
            if (def.kind === 'underground') {
              const nextMode = ugMode === 'out' ? 'in' : 'out';
              setActiveTool({
                ...tool,
                undergroundMode: nextMode,
                pendingUndergroundInId: ugMode === 'in' ? res.addedBuildingIds?.[0] : undefined,
              });
            }
          } else if (res.message) {
            showToast(res.message, 'warn');
          }
        }
      }
    } else if (d.kind === 'box-demolish') {
      const targetSel = d.liveSelection;
      sceneRef.current?.setLiveBoxSelect(null);
      updateBoxBadge(false);
      if (d.moved && targetSel && (targetSel.moduleIds.length > 0 || targetSel.buildingIds.length > 0)) {
        requestDeleteSelection(targetSel);
      } else if (world) {
        const { doc: curDoc, viewMode: vm, focusFloor: fl } = stateRef.current;
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
      }
    } else if (d.kind === 'box-select') {
      const { doc: curDoc, viewMode: vm, focusFloor: fl, selection: prevSel, hideAbove: ha, selectionLayerMode: slm, activeTool: curTool } =
        stateRef.current;
      sceneRef.current?.setLiveBoxSelect(null);
      updateBoxBadge(false);
      if (d.moved && d.startWorld && world) {
        const finalSel =
          d.liveSelection ??
          boxSelectEntities(
            curDoc,
            {
              minX: Math.min(d.startWorld.x, world.x),
              minY: Math.min(d.startWorld.y, world.y),
              maxX: Math.max(d.startWorld.x, world.x),
              maxY: Math.max(d.startWorld.y, world.y),
            },
            { viewMode: vm, focusFloor: fl, hideAbove: ha, layerMode: slm }
          );
        setSelection(finalSel);
        if (curTool.kind !== 'select' && (finalSel.moduleIds.length > 0 || finalSel.buildingIds.length > 0)) {
          setActiveTool({ kind: 'select' });
        }
      } else if (world) {
        const cellX = Math.floor(world.x);
        const cellY = Math.floor(world.y);
        const clickedBld = findBuildingAtCell(curDoc, cellX, cellY, fl);

        // Canvas -> Panel click tracking: clicking any yellow/red marker tracks & scrolls to it in Blueprint Check!
        const curSim = stateRef.current.simReport;
        if (curSim) {
          const faultHits = curSim.faults.filter(
            (i) =>
              i.floor === fl &&
              ((i.x === cellX && i.y === cellY) || (clickedBld !== null && i.buildingId === clickedBld.id))
          );
          const ioHits = stateRef.current.showIoSpots
            ? curSim.ioSpots.filter(
                (s) =>
                  s.floor === fl &&
                  ((s.x === cellX && s.y === cellY) || (clickedBld !== null && s.buildingId === clickedBld.id))
              )
            : [];
          const hits = [
            ...faultHits.map((f) => ({ id: f.id, message: f.message, kind: f.severity as 'error' | 'warn' })),
            ...ioHits.map((s) => ({ id: s.id, message: s.message, kind: 'info' as const })),
          ];
          if (hits.length > 0) {
            const curIdx = hits.findIndex((i) => i.id === stateRef.current.activeSimIssueId);
            const picked = hits[(curIdx + 1) % hits.length];
            setActiveSimIssueId(picked.id);
            showToast(picked.message, picked.kind);
          } else {
            setActiveSimIssueId(null);
          }
        }

        if (vm === 'building') {
          const b = clickedBld;
          if (b) {
            if (e.altKey) {
              setSelection({
                moduleIds: prevSel.moduleIds,
                buildingIds: prevSel.buildingIds.filter((x) => x !== b.id),
              });
            } else if (e.shiftKey) {
              const exists = prevSel.buildingIds.includes(b.id);
              setSelection({
                moduleIds: prevSel.moduleIds,
                buildingIds: exists ? prevSel.buildingIds.filter((x) => x !== b.id) : [...prevSel.buildingIds, b.id],
              });
            } else {
              setSelection({ moduleIds: [], buildingIds: [b.id] });
            }
          } else if (!e.shiftKey && !e.altKey) {
            setSelection(EMPTY_SELECTION);
          }
        } else {
          const m = findModuleAtWorldPoint(curDoc, world.x, world.y, fl);
          if (m) {
            if (e.altKey) {
              setSelection({
                moduleIds: prevSel.moduleIds.filter((x) => x !== m.id),
                buildingIds: prevSel.buildingIds,
              });
            } else if (e.shiftKey) {
              const exists = prevSel.moduleIds.includes(m.id);
              setSelection({
                moduleIds: exists ? prevSel.moduleIds.filter((x) => x !== m.id) : [...prevSel.moduleIds, m.id],
                buildingIds: prevSel.buildingIds,
              });
            } else {
              setSelection({ moduleIds: [m.id], buildingIds: [] });
            }
          } else if (!e.shiftKey && !e.altKey) {
            setSelection(EMPTY_SELECTION);
          }
        }
      }
    } else if (d.kind === 'demolish') {
      if (d.sweepModCount > 0 && d.sweepBldCount > 0) {
        showToast(`已拆除 ${d.sweepModCount} 个模块及内部 ${d.sweepBldCount} 台建筑（Ctrl+Z 撤销）`);
      } else if (d.sweepModCount > 0) {
        showToast(`已拆除 ${d.sweepModCount} 个模块（Ctrl+Z 撤销）`);
      } else if (d.sweepBldCount > 1) {
        showToast(`已扫拆 ${d.sweepBldCount} 台建筑（Ctrl+Z 撤销）`);
      }
    }

    dragRef.current.kind = 'none';
    dragRef.current.moved = false;
    dragRef.current.liveSelection = null;
    dragRef.current.sweepCommitted = false;
    dragRef.current.sweepModCount = 0;
    dragRef.current.sweepBldCount = 0;
    sceneRef.current?.setCameraDragging(false);
  };

  // Native non-passive wheel handler so Shift+Wheel steps floors cleanly without triggering browser scroll!
  const wheelFloorAccumRef = useRef(0);
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheelNative = (e: WheelEvent) => {
      e.preventDefault();
      if (e.shiftKey) {
        const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
        if (delta === 0) return;
        wheelFloorAccumRef.current += delta;
        const threshold = e.deltaMode === 1 ? 1 : 40;
        if (Math.abs(wheelFloorAccumRef.current) >= threshold) {
          const step = wheelFloorAccumRef.current < 0 ? 1 : -1;
          wheelFloorAccumRef.current = 0;
          setFocusFloor((f) => Math.max(-2, Math.min(8, f + step)));
        }
        return;
      }
      wheelFloorAccumRef.current = 0;
      const ctrl = sceneRef.current;
      if (!ctrl) return;
      const rect = viewportRectRef.current;
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      const hit = ctrl.rig.intersectFocusPlane(ndcX, ndcY);
      ctrl.rig.zoomByWheel(e.deltaY, hit);
    };
    el.addEventListener('wheel', onWheelNative, { passive: false });
    return () => el.removeEventListener('wheel', onWheelNative);
  }, []);

  const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (stateRef.current.cleanView || stateRef.current.activeTool.kind !== 'select') return;
    if (stateRef.current.doc.category === 'ship') return;
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
      const curCat = stateRef.current.doc.category ?? 'station';
      const targetCat = loaded.category ?? 'station';
      if (curCat !== targetCat) {
        showToast(
          targetCat === 'ship'
            ? t('飞船蓝图不可盖章到空间站画布，请双击「打开」', 'Cannot stamp a ship onto a station; double-click to Open')
            : t('空间站蓝图不可盖章到飞船画布，请双击「打开」', 'Cannot stamp a station onto a ship; double-click to Open'),
          'warn'
        );
        return;
      }
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
      if (loaded.category === 'ship') {
        setViewMode('station');
        setHideAbove(false);
        setSimOpen(false);
        setActiveSimIssueId(null);
        sceneRef.current?.rig.setViewMode('station', false);
        sceneRef.current?.rig.setYaw(Math.PI, true);
      } else {
        setHideAbove(true);
        sceneRef.current?.rig.setYaw(0, true);
      }
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
      const lower = file.name.toLowerCase();
      if (lower.endsWith('.sav')) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const { doc: imported, report } = await importNativeSav(bytes);
        const baseName = sanitizeFileName(imported.name || file.name.replace(/\.sav$/i, ''));
        const targetPath = `导入蓝图/${baseName}`;
        await driver.writeBlueprint(targetPath, imported);
        await refreshLibrary();
        // Immediately open imported .sav station on canvas & frame its center
        setHistory(createHistory(imported));
        setActiveSourcePath(targetPath);
        setDirty(false);
        setSelection(EMPTY_SELECTION);
        setActiveTool({ kind: 'select' });
        const floors = imported.modules.map((m) => m.floor);
        const targetFloor = floors.length ? Math.min(...floors.filter((f) => f >= 0), floors[0]) : 0;
        setFocusFloor(targetFloor);
        if (imported.modules.length > 0) {
          let sumX = 0;
          let sumY = 0;
          let count = 0;
          for (const m of imported.modules) {
            const mDef = getModuleDef(m.type);
            if (mDef) {
              const [minX, minY, maxX, maxY] = getModuleBoundsM(m, mDef);
              sumX += (minX + maxX) * 0.5;
              sumY += (minY + maxY) * 0.5;
            } else {
              const unitM = getFrameGridSpec(imported.category).unitM;
              sumX += m.gx * unitM + unitM * 0.5;
              sumY += m.gy * unitM + unitM * 0.5;
            }
            count++;
          }
          sceneRef.current?.rig.focusPoint(sumX / count, sumY / count, 92);
        }
        showToast(
          `已导入原生 .sav「${imported.name}」（${report.module_count} 站体 · ${report.building_count} 建筑${report.warnings.length ? ` · ${report.warnings.length} 条提示` : ''}）`,
          report.warnings.length ? 'warn' : 'info'
        );
        return;
      }

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

  const openGitHubConnectModal = () => {
    const existing = driver instanceof GitHubPrivateRepoDriver ? driver.config : loadSavedGitHubConfig();
    setGhModal({
      repoSlug: existing ? `${existing.owner}/${existing.repo}` : '',
      branch: existing?.branch || 'main',
      basePath: existing?.basePath || '',
      token: existing?.token || '',
      busy: false,
      error: null,
    });
  };

  const handleConnectGitHubRepo = async () => {
    if (!ghModal) return;
    const parts = ghModal.repoSlug
      .trim()
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/\.git$/i, '')
      .split('/')
      .filter(Boolean);
    if (parts.length < 2) {
      setGhModal({ ...ghModal, error: '请填写 owner/repo 格式' });
      return;
    }
    if (!ghModal.token.trim()) {
      setGhModal({ ...ghModal, error: '请填写 Fine-grained PAT' });
      return;
    }
    setGhModal({ ...ghModal, busy: true, error: null });
    const cfg = {
      owner: parts[0],
      repo: parts[1],
      branch: ghModal.branch.trim() || 'main',
      basePath: ghModal.basePath.trim(),
      token: ghModal.token.trim(),
    };
    const nextDriver = new GitHubPrivateRepoDriver(cfg);
    try {
      const nodes = await nextDriver.listTree();
      saveGitHubConfig(cfg);
      setDriver(nextDriver);
      setLibraryTree(nodes);
      setGhModal(null);
      showToast(`已连接 GitHub 私有蓝图库：${cfg.owner}/${cfg.repo}`);
    } catch (err) {
      setGhModal({
        ...ghModal,
        busy: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleDisconnectGitHubRepo = async () => {
    clearSavedGitHubConfig();
    clearWorkspaceAutosave();
    const fallback = new VirtualFolderDriver();
    const pubTemplate = DEFAULT_LIBRARY_PRESETS.find((p) => !p.isPrivate);
    const resetDoc = pubTemplate ? pubTemplate.doc : createStarterBlueprint();
    setDriver(fallback);
    setHistory(createHistory(resetDoc));
    setActiveSourcePath(pubTemplate ? pubTemplate.path : null);
    setDirty(false);
    setSelection(EMPTY_SELECTION);
    setActiveTool({ kind: 'select' });
    setStampingLibPath(null);
    setGhModal(null);
    await refreshLibrary(fallback);
    showToast('已断开私有云库并清除本地 Token 与画布缓存，已切回公开起步模板');
  };

  const handleExportNativeSav = async (mode: 'station' | 'preset' = 'station', targetDoc: BlueprintDocument = doc) => {
    try {
      const { bytes, report } = await exportNativeSav(targetDoc, mode);
      const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const baseName = sanitizeFileName(targetDoc.name || 'station').replace(/\.json$/i, '');
      const suffix = mode === 'preset' ? '.preset.sav' : '.sav';
      a.download = `${baseName}${suffix}`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(
        mode === 'preset'
          ? `已导出 Mod 局部预设 ${baseName}${suffix}（${report.module_count} 站体 · ${report.native_machine_count} 机器）`
          : `已导出游戏原生 ${baseName}.sav（${report.module_count} 站体 · ${report.native_machine_count} 机器 · ${report.connector_count} 连接口${report.warnings.length ? ` · ${report.warnings.length} 条提示` : ''}）`,
        report.warnings.length ? 'warn' : 'info'
      );
    } catch (err) {
      showToast(`导出原生 .sav 失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  const handleExportCanonicalJson = () => {
    const blob = new Blob([serializeBlueprint(doc)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = sanitizeFileName(doc.name || 'blueprint');
    a.click();
    URL.revokeObjectURL(url);
    showToast(`已导出规范蓝图 ${a.download}`);
  };

  const handleExportSavFromLibrary = async (file: LibraryFileEntry) => {
    try {
      const { doc: libDoc } = await driver.readBlueprint(file.path);
      await handleExportNativeSav('station', libDoc);
    } catch (err) {
      showToast(`导出 .sav 失败：${err instanceof Error ? err.message : String(err)}`, 'error');
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

  const handleNewBlueprint = (category: BlueprintCategory = 'station') => {
    const label = category === 'ship' ? '飞船' : '空间站';
    if (dirty && !window.confirm(`当前画布有未保存更改，确定新建空白${label}吗？`)) return;
    const fresh = createEmptyBlueprint(category === 'ship' ? '新建飞船' : '新建空间站', category);
    setHistory(createHistory(fresh));
    setActiveSourcePath(null);
    setDirty(false);
    setSelection(EMPTY_SELECTION);
    setFocusFloor(0);
    setSimOpen(false);
    setActiveSimIssueId(null);
    setViewMode('station');
    if (category === 'ship') {
      setHideAbove(false);
      setActiveTool({ kind: 'place-module', moduleType: 'BPO_Cockpit_01', rotation: 0 });
      sceneRef.current?.rig.setViewMode('station', false);
      sceneRef.current?.rig.setYaw(Math.PI, true);
      sceneRef.current?.rig.focusPoint(4, 4, 42);
    } else {
      setHideAbove(true);
      setActiveTool({ kind: 'place-module', moduleType: 'BPO_Station_02A', rotation: 0 });
      sceneRef.current?.rig.setViewMode('station', true);
      sceneRef.current?.rig.setYaw(0, true);
      sceneRef.current?.rig.focusPoint(16, 16, 76);
    }
  };

  const isShip = doc.category === 'ship';
  const shipStats = useMemo(() => (isShip ? computeShipStats(doc) : null), [isShip, doc]);
  const folderOptions = useMemo(() => collectFolderPaths(libraryTree), [libraryTree]);
  const hasRightPanel = !isShip && (simOpen || selection.moduleIds.length > 0 || selection.buildingIds.length > 0);
  const saveTargetLabel =
    driver.mode === 'github-private'
      ? t('写入私有云库', 'Save to Cloud')
      : driver.mode === 'fs-local'
        ? t('写入本地目录', 'Save Locally')
        : t('写入内置库', 'Save Built-in');

  const toolBannerSpec = useMemo((): {
    mode: string;
    badge?: string;
    tone: 'default' | 'accent' | 'danger';
    hints: KeyHintItem[];
  } | null => {
    if (activeTool.kind === 'select') return null;

    if (activeTool.kind === 'demolish') {
      return {
        mode: t('拆除', 'Erase'),
        tone: 'danger',
        hints: [
          { keys: t('左键', 'LMB'), label: t('点/扫', 'Sweep') },
          { keys: t('Shift+拖', 'Shift+Drag'), label: t('框拆', 'Box') },
          { keys: 'Esc', label: t('退出', 'Exit') },
        ],
      };
    }

    if (activeTool.kind === 'place-module') {
      const def = getModuleDef(activeTool.moduleType);
      const docCat = doc.category ?? 'station';
      const grp = findGroupForEntity('station', activeTool.moduleType, docCat);
      const isArmour =
        activeTool.moduleType === 'BPO_StationArmour_01' || activeTool.moduleType === 'BPO_StationArmour_01B';
      const canRot = !isShip || shipFreeRotate || def?.canRotate !== false;
      const showMirror = !isShip || Boolean(def?.mirrorId);
      return {
        mode: getShortLabel(activeTool.moduleType, isEn ? def?.nameEn : def?.nameZh, lang),
        badge: activeTool.label || undefined,
        tone: 'accent',
        hints: [
          ...(canRot
            ? [{ keys: 'R', label: t('旋转', 'Rotate') }]
            : [{ keys: 'R', label: t('原版锁向', 'Locked') }]),
          ...(showMirror
            ? [{ keys: 'F', label: isArmour || def?.mirrorId ? t('镜像', 'Mirror') : t('镜像', 'Mirror') }]
            : []),
          { keys: 'Q/E', label: t('切层', 'Floor') },
          ...(grp && grp.members.length > 1 ? [{ keys: 'Tab', label: t('换型', 'Variant') }] : []),
        ],
      };
    }

    if (activeTool.kind === 'place-building') {
      if (beltSessionMode === 'plan') {
        return {
          mode: t('拉带', 'Route'),
          tone: 'accent',
          hints: [
            { keys: t('左键', 'LMB'), label: t('落位', 'Place') },
            { keys: t('中键', 'MMB'), label: t('锚点', 'Anchor') },
            { keys: 'F', label: t('换角', 'Corner') },
            { keys: 'R', label: t('转向', 'Turn') },
            { keys: 'T', label: t('地下', 'Tunnel'), active: beltHudFlags.tunnel },
            { keys: 'Alt', label: t('反向', 'Rev'), active: beltHudFlags.reverse },
            { keys: '⌫', label: t('退步', 'Undo') },
          ],
        };
      }
      if (beltSessionMode === 'stroke') {
        return {
          mode: t('手绘', 'Freehand'),
          tone: 'accent',
          hints: [
            { keys: t('左键', 'LMB'), label: t('落位', 'Place') },
            { keys: 'T', label: t('地下', 'Tunnel'), active: beltHudFlags.tunnel },
            { keys: 'R', label: t('转向', 'Turn') },
            { keys: 'Alt', label: t('反向', 'Rev'), active: beltHudFlags.reverse },
            { keys: '⌫', label: t('退格', 'Undo') },
          ],
        };
      }
      const def = getBuildableDef(activeTool.buildingType);
      const grp = findGroupForEntity('building', activeTool.buildingType);
      const name = getShortLabel(activeTool.buildingType, isEn ? def?.nameEn : def?.nameZh, lang);
      if (def?.kind === 'belt') {
        return {
          mode: name,
          tone: 'accent',
          hints: [
            { keys: t('左键', 'LMB'), label: t('拉带', 'Route') },
            { keys: t('Shift+左', 'Shift+LMB'), label: t('手绘', 'Free') },
            { keys: 'T', label: t('地下', 'Tunnel') },
            { keys: 'Tab', label: t('换型', 'Variant') },
          ],
        };
      }
      if (def?.kind === 'underground') {
        return {
          mode: name,
          badge: activeTool.undergroundMode === 'out' ? 'OUT' : 'IN',
          tone: 'accent',
          hints: [
            { keys: 'R', label: t('旋转', 'Rotate') },
            { keys: 'T', label: t('地面', 'Belt') },
            { keys: 'Tab', label: t('换型', 'Variant') },
          ],
        };
      }
      const recBadge = activeTool.recipeId
        ? getRecipeDef(activeTool.recipeId)
          ? getRecipeName(getRecipeDef(activeTool.recipeId)!, lang)
          : activeTool.recipeId
        : undefined;
      return {
        mode: name,
        badge: recBadge,
        tone: 'default',
        hints: [
          { keys: 'R', label: t('旋转', 'Rotate') },
          { keys: 'F', label: t('镜像', 'Mirror') },
          ...(grp && grp.members.length > 1 ? [{ keys: 'Tab', label: t('换型', 'Variant') }] : []),
        ],
      };
    }

    return {
      mode: activeTool.fromCut ? t('搬移', 'Move') : t('粘贴', 'Paste'),
      badge: activeTool.name,
      tone: 'accent',
      hints: [
        { keys: 'R', label: t('旋转', 'Rotate') },
        { keys: 'F', label: t('镜像', 'Mirror') },
        { keys: 'Q/E', label: t('切层', 'Floor') },
        ...(!activeTool.fromCut ? [{ keys: 'Shift', label: t('覆盖', 'Overwrite') }] : []),
      ],
    };
  }, [activeTool, beltHudFlags.reverse, beltHudFlags.tunnel, beltSessionMode, doc.category, isEn, isShip, lang, shipFreeRotate, t]);

  return (
    <div className={`cad-shell ${cleanView ? 'clean-view' : ''}`} data-theme={theme}>
      <header className="cad-topbar" aria-hidden={cleanView || undefined}>
          <div className="topbar-group">
            <span className="brand-mark">MS · CAD</span>
            <div className="doc-title-wrap">
              <span
                className={`doc-status-dot ${dirty ? 'dirty' : 'clean'}`}
                title={dirty ? t('未保存', 'Unsaved') : activeSourcePath ? t('已保存', 'Saved') : t('草稿', 'Draft')}
              />
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
                aria-label={t('蓝图名称', 'Blueprint name')}
              />
            </div>
            <button type="button" className="cad-btn" onClick={() => openSaveDialog(false)} title="Ctrl+S">
              {t('保存', 'Save')}
            </button>
          </div>

          <div className="topbar-group topbar-center">
            {isShip ? (
              <span className="topbar-mode-pill" aria-label={t('飞船模式', 'Ship mode')}>
                {t('飞船设计', 'Ship Designer')}
              </span>
            ) : (
              <div className="segmented">
                <button
                  type="button"
                  className={`seg-btn ${viewMode === 'station' ? 'active' : ''}`}
                  onClick={() => switchViewMode('station')}
                  title={t('空间站视野 (` / Tab)', 'Station View (` / Tab)')}
                >
                  {t('空间站', 'Station')}
                </button>
                <button
                  type="button"
                  className={`seg-btn ${viewMode === 'building' ? 'active' : ''}`}
                  onClick={() => switchViewMode('building')}
                  title={t('建筑视野 (` / Tab)', 'Building View (` / Tab)')}
                >
                  {t('建筑', 'Building')}
                </button>
              </div>
            )}
          </div>

          <div className="topbar-group right-aligned">
            {!isShip && (
              <button
                type="button"
                className={`cad-btn ${simOpen ? (simReport?.passed ? 'sim-ok' : 'sim-err') : ''}`}
                onClick={() => setSimOpen((v) => !v)}
              >
                {simOpen
                  ? !simReport?.passed
                    ? t(`体检 · ${simReport?.errorCount ?? 0}错`, `Check · ${simReport?.errorCount ?? 0} Err`)
                    : (simReport?.warnCount ?? 0) > 0
                      ? t(`体检 · ${simReport?.warnCount ?? 0}警`, `Check · ${simReport?.warnCount ?? 0} Warn`)
                      : t('体检 · 正常', 'Check · OK')
                  : t('体检', 'Check')}
              </button>
            )}

            <GameInteropMenu
              docCategory={doc.category}
              onImportFile={(f) => void handleImportJsonFile(f)}
              onExportNativeSav={(mode) => void handleExportNativeSav(mode)}
              onExportCanonicalJson={handleExportCanonicalJson}
            />

            <div className="interop-anchor" ref={prefsMenuRef} {...prefsMenuContainerProps}>
              <button
                type="button"
                className={`cad-btn ${prefsMenuOpen ? 'accent' : ''}`}
                onClick={onPrefsTriggerClick}
                aria-label={t('视角与偏好', 'View & Preferences')}
                aria-expanded={prefsMenuOpen}
                aria-haspopup="menu"
              >
                {t('视角 ▾', 'View ▾')}
              </button>
              {prefsMenuOpen && (
                <div className="prefs-popover">
                  <div className="prefs-section">
                    <div className="prefs-title">{t('相机与吸附', 'Camera')}</div>
                    <div className="prefs-row">
                      <button
                        type="button"
                        className={`cad-btn ${snapEnabled ? 'accent' : ''}`}
                        onClick={() => {
                          const next = !snapEnabled;
                          setSnapEnabled(next);
                          sceneRef.current?.rig.setSnapEnabled(next);
                        }}
                      >
                        {snapEnabled ? t('吸附 · 开 (G)', 'Snap · On (G)') : t('自由 · 关 (G)', 'Free (G)')}
                      </button>
                      <button
                        type="button"
                        className="cad-btn"
                        onClick={() => sceneRef.current?.rig.stepYawCardinal(1)}
                        title={t('旋转 90°', 'Rotate 90°')}
                      >
                        ↻90°
                      </button>
                      <button
                        type="button"
                        className="cad-btn"
                        onClick={() => {
                          fitAllStation();
                          setPrefsMenuOpen(false);
                        }}
                        title="Home"
                      >
                        {t('适配', 'Fit')}
                      </button>
                    </div>
                    <div className="pitch-pills prefs-pitch">
                      {PITCH_SNAP_PRESETS.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          className="mini-pill"
                          onClick={() => sceneRef.current?.rig.setPitchPreset(p.rad)}
                          title={isEn ? p.labelEn : p.label}
                        >
                          {isEn ? p.labelEn.split(' ')[0] : p.label.slice(0, 2)}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="cad-btn prefs-full"
                      onClick={enterCleanView}
                    >
                      {t('无 UI 预览 (H)', 'Clean View (H)')}
                    </button>
                  </div>

                  <div className="prefs-section">
                    <div className="prefs-title">{t('编辑与框选', 'Edit')}</div>
                    <div className="prefs-row">
                      <button
                        type="button"
                        className="cad-btn"
                        disabled={history.past.length === 0}
                        onClick={() => setHistory((h) => undoHistory(h))}
                      >
                        {t('撤销 (Ctrl+Z)', 'Undo')}
                      </button>
                      <button
                        type="button"
                        className="cad-btn"
                        disabled={history.future.length === 0}
                        onClick={() => setHistory((h) => redoHistory(h))}
                      >
                        {t('重做', 'Redo')}
                      </button>
                    </div>
                    <button
                      type="button"
                      className="cad-btn prefs-full"
                      onClick={() =>
                        setSelectionLayerMode((m) => (m === 'focus' ? 'visible' : m === 'visible' ? 'all' : 'focus'))
                      }
                    >
                      {t('框选层域 (B)：', 'Layer Scope (B): ')}
                      {selectionLayerMode === 'focus'
                        ? t('仅当前层', 'Focus')
                        : selectionLayerMode === 'visible'
                          ? t('可见层', 'Visible')
                          : t('全部', 'All')}
                    </button>
                    {isShip && (
                      <button
                        type="button"
                        className={`cad-btn prefs-full ${shipFreeRotate ? 'accent' : ''}`}
                        onClick={() => {
                          setShipFreeRotate((v) => {
                            const next = !v;
                            showToast(
                              next
                                ? t('已开启飞船自由旋转（解除原版朝向锁）', 'Ship Free Rotate: ON (native lock bypassed)')
                                : t('已恢复原版飞船朝向锁定（锁定件仅 F 镜像）', 'Ship Free Rotate: OFF (native orientation rules)')
                            );
                            return next;
                          });
                        }}
                      >
                        {shipFreeRotate
                          ? t('飞船自由旋转 · 开', 'Free Rotate · On')
                          : t('飞船自由旋转 · 关（原版）', 'Free Rotate · Off (Native)')}
                      </button>
                    )}
                  </div>

                  <div className="prefs-section">
                    <div className="prefs-title">{t('外观', 'Theme')}</div>
                    <button
                      type="button"
                      className="cad-btn prefs-full"
                      onClick={() => {
                        const next: CadThemeId = theme === 'platinum-gold' ? 'stealth-cad' : 'platinum-gold';
                        setTheme(next);
                        saveTheme(next);
                      }}
                    >
                      {isEn ? CAD_THEMES[theme].nameEn : CAD_THEMES[theme].nameZh}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <button
              type="button"
              className="cad-btn"
              onClick={toggleLang}
              aria-label={t('切换为 English', 'Switch to 中文')}
            >
              {isEn ? '中' : 'EN'}
            </button>

            <button
              type="button"
              className={`cad-btn icon-pill ${helpOpen ? 'accent' : ''}`}
              onClick={() => setHelpOpen((o) => !o)}
              title={t('快捷键 (F1 / ?)', 'Shortcuts (F1 / ?)')}
            >
              ?
            </button>
          </div>
      </header>

      <div className="cad-main">
        <LibrarySidebar
          open={libraryOpen}
          onToggleOpen={() => setLibraryOpen((o) => !o)}
          onOpenModal={() => setLibraryModalOpen(true)}
          driverMode={driver.mode}
          rootLabel={driver.rootLabel}
          tree={libraryTree}
          activeSourcePath={activeSourcePath}
          stampingPath={stampingLibPath}
          onNewBlueprint={handleNewBlueprint}
          onStampFromLibrary={handleStampFromLibrary}
          onOpenFromLibrary={handleOpenFromLibrary}
        />

        <div
          ref={viewportRef}
          className={`cad-viewport ${cleanView ? 'tool-clean' : `tool-${activeTool.kind}`}`}
          onContextMenu={(e) => e.preventDefault()}
          onDragOver={(e) => {
            if (!cleanView && e.dataTransfer.types.includes('Files')) {
              e.preventDefault();
            }
          }}
          onDrop={(e) => {
            if (cleanView) return;
            const dropped = e.dataTransfer.files?.[0];
            if (dropped && /\.(sav|json)$/i.test(dropped.name)) {
              e.preventDefault();
              void handleImportJsonFile(dropped);
            }
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={() => {
            pendingPointerRef.current = null;
            dragRef.current.kind = 'none';
            dragRef.current.moved = false;
            dragRef.current.liveSelection = null;
            sceneRef.current?.setCameraDragging(false);
            sceneRef.current?.setLiveBoxSelect(null);
            updateBoxBadge(false);
          }}
          onPointerLeave={() => {
            pendingPointerRef.current = null;
            processedPointerWorldRef.current = null;
            updateLiveCursor(null);
            hideHoverTip();
          }}
          onDoubleClick={handleDoubleClick}
        />

        <div className="cad-focal-vignette" aria-hidden="true" />
        <div ref={boxBadgeRef} className="cad-box-badge" style={{ display: 'none' }} />
        <div ref={hoverTipRef} className="cad-hover-tip" style={{ display: 'none' }} aria-hidden="true">
          <div ref={hoverTitleRef} className="cad-hover-tip-title" />
          <div ref={hoverSubRef} className="cad-hover-tip-sub" />
          <div ref={hoverNoteRef} className="cad-hover-tip-note" />
        </div>

        <div className={`cad-hud-topright ${hasRightPanel ? 'shifted' : ''}`} aria-live="off" aria-hidden={cleanView || undefined}>
          <div className="hud-row primary">
            <span className="hud-coord" ref={hudCoordRef}>X --  Y --</span>
            <span className="hud-sep">·</span>
            <span className="hud-grid" ref={hudGridRef}>G(-,-)</span>
            <span className="hud-floor">{formatFloorTag(focusFloor)}</span>
          </div>
          <div className="hud-row secondary">
            <span>
              {isShip ? t('飞船', 'Ship') : viewMode === 'station' ? t('空间站', 'Station') : t('建筑', 'Building')}
            </span>
            <span ref={hudCamRef}>0°/64° · 76m</span>
            <span>{snapEnabled ? t('吸附', 'Snap') : t('自由', 'Free')}</span>
            <span>
              {isShip
                ? isEn
                  ? `${doc.modules.length}M`
                  : `${doc.modules.length}模`
                : isEn
                  ? `${doc.modules.length}M · ${doc.buildings.length}B`
                  : `${doc.modules.length}模 · ${doc.buildings.length}建`}
            </span>
            {lastAutosaveAt && (
              <span title={t('自动恢复点', 'Autosave')}>{new Date(lastAutosaveAt).toLocaleTimeString()}</span>
            )}
          </div>
        </div>

        <FloorStackRail
          doc={doc}
          focusFloor={focusFloor}
          hideAbove={hideAbove}
          shifted={hasRightPanel}
          onSelectFloor={setFocusFloor}
          onToggleHideAbove={() => setHideAbove((v) => !v)}
        />

        {isShip && shipStats && <ShipParamsHud stats={shipStats} />}

        {!isShip && (
          <InspectorPanel
            doc={doc}
            selection={selection}
            onUpdateBuilding={(ids, patch) => {
              const res = updateBuildingConfigCmd(doc, ids, patch);
              if (res.changed) commitDoc(res.doc);
            }}
            onUpdateModuleConfig={(id, patch) => {
              const res = updateModuleConfigCmd(doc, id, patch);
              if (res.changed) commitDoc(res.doc);
            }}
            onCopySelection={() => copySelectionToGhost(false)}
            onCutSelection={() => copySelectionToGhost(true)}
            onSaveSelectionAsBlueprint={() => openSaveDialog(true)}
            onRotateSelection={() => {
              const res = rotateSelectionInPlaceCmd(doc, selection, 1);
              if (res.changed) commitDoc(res.doc);
            }}
            onMirrorSelection={(vertical) => applyMirrorAction(Boolean(vertical))}
            onDeleteSelection={() => requestDeleteSelection(selection)}
            onClearSelection={() => setSelection(EMPTY_SELECTION)}
          />
        )}

        {!isShip && (
          <SimulationPanel
            open={simOpen}
            report={simReport}
            activeIssueId={activeSimIssueId}
            showIoSpots={showIoSpots}
            onToggleShowIoSpots={() => setShowIoSpots((v) => !v)}
            onClose={() => {
              setSimOpen(false);
              setActiveSimIssueId(null);
            }}
            onFocusTarget={(target: CheckFocusTarget) => {
              setActiveSimIssueId(target.id);
              setFocusFloor(target.floor);
              if (target.moduleId && !target.buildingId) {
                switchViewMode('station', [target.x + 0.5, target.y + 0.5]);
                setSelection({ moduleIds: [target.moduleId], buildingIds: [] });
              } else {
                switchViewMode('building', [target.x + 0.5, target.y + 0.5]);
                if (target.buildingId) {
                  setSelection({ moduleIds: [], buildingIds: [target.buildingId] });
                }
              }
            }}
          />
        )}

        {toolBannerSpec && (
          <ToolActionBar
            mode={toolBannerSpec.mode}
            badge={toolBannerSpec.badge}
            tone={toolBannerSpec.tone}
            hints={toolBannerSpec.hints}
          />
        )}

        <PaletteDock
          viewMode={viewMode}
          docCategory={doc.category}
          shipFreeRotate={shipFreeRotate}
          activeTool={activeTool}
          lastGroupMember={lastGroupMember}
          onSelectEntity={(id) => selectEntityTool(id)}
          onSelectTool={(tTool) => {
            setActiveTool(tTool);
            setStampingLibPath(null);
          }}
        />
      </div>

      <BlueprintLibraryModal
        open={libraryModalOpen}
        onClose={() => setLibraryModalOpen(false)}
        driver={driver}
        fsSupported={FileSystemFolderDriver.isSupported()}
        tree={libraryTree}
        theme={theme}
        activeSourcePath={activeSourcePath}
        stampingPath={stampingLibPath}
        onMountLocalFolder={handleMountLocalFolder}
        onOpenGitHubConnect={openGitHubConnectModal}
        onRefresh={() => void refreshLibrary(undefined, true)}
        onNewBlueprint={handleNewBlueprint}
        onCreateFolder={handleCreateFolder}
        onImportJsonFile={handleImportJsonFile}
        onStampFromLibrary={handleStampFromLibrary}
        onOpenFromLibrary={handleOpenFromLibrary}
        onExportFromLibrary={handleExportFromLibrary}
        onExportSavFromLibrary={(f) => void handleExportSavFromLibrary(f)}
        onDeleteEntry={handleDeleteLibEntry}
        onMoveFile={handleMoveLibFile}
      />

      <HelpDrawer open={helpOpen} onClose={() => setHelpOpen(false)} />

      {ghModal && (
        <div className="cad-modal-overlay" onClick={() => !ghModal.busy && setGhModal(null)}>
          <div className="cad-modal" onClick={(e) => e.stopPropagation()}>
            <div className="panel-header">
              <div className="panel-title-wrap">
                <span className="panel-tag">CLOUD</span>
                <span className="panel-title">{t('GitHub 私有蓝图库', 'GitHub Private Repo')}</span>
              </div>
              <button type="button" className="icon-btn" onClick={() => !ghModal.busy && setGhModal(null)}>×</button>
            </div>
            <div className="modal-body">
              <label className="field-label">
                <span>{t('仓库', 'Repository')}</span>
                <input
                  type="text"
                  className="cad-input"
                  placeholder="owner/repo"
                  value={ghModal.repoSlug}
                  onChange={(e) => setGhModal({ ...ghModal, repoSlug: e.target.value })}
                />
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 8 }}>
                <label className="field-label">
                  <span>{t('分支', 'Branch')}</span>
                  <input
                    type="text"
                    className="cad-input"
                    value={ghModal.branch}
                    onChange={(e) => setGhModal({ ...ghModal, branch: e.target.value })}
                  />
                </label>
                <label className="field-label">
                  <span>{t('子目录', 'Subpath')}</span>
                  <input
                    type="text"
                    className="cad-input"
                    placeholder={t('留空为根目录', 'Empty for root')}
                    value={ghModal.basePath}
                    onChange={(e) => setGhModal({ ...ghModal, basePath: e.target.value })}
                  />
                </label>
              </div>
              <label className="field-label">
                <span>Fine-grained PAT</span>
                <input
                  type="password"
                  className="cad-input"
                  placeholder="github_pat_..."
                  value={ghModal.token}
                  onChange={(e) => setGhModal({ ...ghModal, token: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !ghModal.busy) void handleConnectGitHubRepo();
                  }}
                />
              </label>
              <div className="modal-sub">{t('Token 仅存本机浏览器，断开即清除', 'Stored locally in browser only; cleared on disconnect')}</div>
              {ghModal.error && (
                <div className="modal-sub" style={{ color: 'var(--line-disabled)' }}>
                  {ghModal.error}
                </div>
              )}
            </div>
            <div className="modal-footer">
              {(driver.mode === 'github-private' || loadSavedGitHubConfig()) && (
                <button
                  type="button"
                  className="cad-btn danger"
                  disabled={ghModal.busy}
                  onClick={() => void handleDisconnectGitHubRepo()}
                >
                  {t('断开并清除', 'Disconnect')}
                </button>
              )}
              <button type="button" className="cad-btn" disabled={ghModal.busy} onClick={() => setGhModal(null)}>
                {t('取消', 'Cancel')}
              </button>
              <button
                type="button"
                className="cad-btn accent"
                disabled={ghModal.busy}
                onClick={() => void handleConnectGitHubRepo()}
              >
                {ghModal.busy ? t('连接中...', 'Connecting...') : t('连接', 'Connect')}
              </button>
            </div>
          </div>
        </div>
      )}

      {saveDialog && (
        <div className="cad-modal-overlay" onClick={() => setSaveDialog(null)}>
          <div className="cad-modal" onClick={(e) => e.stopPropagation()}>
            <div className="panel-header">
              <div className="panel-title-wrap">
                <span className="panel-tag">SAVE</span>
                <span className="panel-title">
                  {saveDialog.mode === 'selection' ? t('保存选区蓝图', 'Save Selection') : t('保存蓝图', 'Save Blueprint')}
                </span>
              </div>
              <button type="button" className="icon-btn" onClick={() => setSaveDialog(null)}>×</button>
            </div>
            <div className="modal-body">
              <label className="field-label">
                <span>{t('目录', 'Folder')}</span>
                <select
                  className="cad-input"
                  value={saveDialog.folder}
                  onChange={(e) => setSaveDialog({ ...saveDialog, folder: e.target.value })}
                >
                  {folderOptions.map((f) => (
                    <option key={f || '__root'} value={f}>
                      {f ? `/${f}` : '/'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-label">
                <span>{t('名称', 'Name')}</span>
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
                {isEn
                  ? `${saveDialog.docToSave.modules.length}M · ${saveDialog.docToSave.buildings.length}B`
                  : `${saveDialog.docToSave.modules.length} 模 · ${saveDialog.docToSave.buildings.length} 建`}
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="cad-btn" onClick={() => setSaveDialog(null)}>{t('取消', 'Cancel')}</button>
              <button type="button" className="cad-btn accent" onClick={() => void executeSaveDialog()}>
                {saveTargetLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className={`cad-toast ${toast.kind} ${cleanView ? 'clean-view' : ''}`} role="status" aria-live="polite">
          {toast.text}
        </div>
      )}
    </div>
  );
};
