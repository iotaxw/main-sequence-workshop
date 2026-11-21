import * as THREE from 'three';
import { getBuildableDef, getModuleDef, getRecipeDef } from '../core/catalog';
import { computeStampCandidates, getBlueprintBoundsM } from '../core/commands';
import {
  computeUndergroundLinks,
  FLOOR_VISUAL_SPACING,
  getBuildingCenterM,
  getBuildingSizeCells,
  getBuildingWorldPorts,
  getModuleBoundsM,
  getModuleCenterM,
  getModuleSizeUnits,
  getModuleWorldConnectors,
  STATION_UNIT_M,
  validateBuildingPlacement,
  validateModulePlacement,
} from '../core/geometry';
import type {
  ActiveTool,
  BlueprintDocument,
  BuildableDef,
  PlacedBuilding,
  PlacedModule,
  Rotation,
  SelectionLayerMode,
  SelectionState,
  StationFloorSurfaceDef,
  StationModuleDef,
  ViewMode,
} from '../core/types';
import { CadCameraRig } from './camera-rig';
import { createRoundedGridOverlay } from './rounded-grid-shader';

// Dark Precision CAD Palette
const COLORS = {
  bg: 0x0b0f16,
  slabFill: 0x131b26,
  slabEdge: 0x475569,
  slabEdgeSelected: 0x38bdf8,
  floorFill: 0x172130,
  floorBalconyFill: 0x1a2739,
  floorEdge: 0x334155,
  connLarge: 0x38bdf8,
  connXLarge: 0x2dd4bf,
  connVertical: 0xa78bfa,
  validGhost: 0x22d3ee,
  invalidGhost: 0xef4444,
  portActive: 0x22c55e,
  portDisabled: 0x991b1b,
  portDisabledRim: 0xdc2626,
  beltMk1: 0x64748b,
  beltMk2: 0x38bdf8,
  beltMk3: 0xa78bfa,
  selectOutline: 0x38bdf8,
  heightFrame: 0x334155,
  refAxisX: 0x1e3a5f,
  refAxisZ: 0x1e3a5f,
};

function buildingAccentColor(def: BuildableDef): number {
  switch (def.kind) {
    case 'crafter': return 0x38bdf8;
    case 'research': return 0x2dd4bf;
    case 'reactor': return 0xeab308;
    case 'belt':
    case 'underground':
      return def.tier === 3 ? COLORS.beltMk3 : def.tier === 2 ? COLORS.beltMk2 : COLORS.beltMk1;
    case 'splitter':
    case 'balancer':
      return def.tier === 3 ? 0xc4b5fd : def.tier === 2 ? 0x7dd3fc : 0x94a3b8;
    case 'container': return 0x94a3b8;
    case 'workbench':
    case 'teleporter': return 0x60a5fa;
    default: return 0x64748b;
  }
}

function buildingFillColor(def: BuildableDef): number {
  switch (def.kind) {
    case 'crafter': return 0x162436;
    case 'research': return 0x13282b;
    case 'reactor': return 0x282315;
    case 'belt': return 0x192332;
    case 'underground': return 0x1f2a3c;
    case 'splitter':
    case 'balancer': return 0x1d293b;
    case 'container': return 0x1c2533;
    default: return 0x1a2230;
  }
}

export interface SceneRenderState {
  doc: BlueprintDocument;
  viewMode: ViewMode;
  focusFloor: number;
  hideAbove: boolean;
  selection: SelectionState;
  selectionLayerMode: SelectionLayerMode;
  activeTool: ActiveTool;
  cursorWorld: { x: number; y: number } | null;
  beltPreview: Array<{ x: number; y: number; rotation: Rotation }>;
  boxSelectRect: { minX: number; minY: number; maxX: number; maxY: number } | null;
  forceReplaceHeld: boolean;
}

const labelTextureCache = new Map<string, THREE.CanvasTexture>();

function getLabelTexture(title: string, subtitle: string | null): THREE.CanvasTexture {
  const key = `${title}||${subtitle ?? ''}`;
  const cached = labelTextureCache.get(key);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#cbd5e1';
  ctx.font = '600 24px "Segoe UI", "Microsoft YaHei", sans-serif';
  const yTitle = subtitle ? 44 : 64;
  ctx.fillText(title.slice(0, 10), 128, yTitle, 236);

  if (subtitle) {
    ctx.fillStyle = '#38bdf8';
    ctx.font = '500 20px "JetBrains Mono", Consolas, "Microsoft YaHei", monospace';
    ctx.fillText(subtitle.slice(0, 12), 128, 86, 236);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  labelTextureCache.set(key, tex);
  return tex;
}

function createFloorShapeGeometry(surf: StationFloorSurfaceDef): THREE.ShapeGeometry {
  const shape = new THREE.Shape();
  if (surf.shape === 'corner-ws') {
    // Diagonal beveled corner
    shape.moveTo(surf.minX, -surf.minY);
    shape.lineTo(2, -surf.minY);
    shape.lineTo(surf.maxX, -(surf.maxY - 2));
    shape.lineTo(surf.maxX, -surf.maxY);
    shape.lineTo(surf.minX, -surf.maxY);
    shape.closePath();
  } else {
    shape.moveTo(surf.minX, -surf.minY);
    shape.lineTo(surf.maxX, -surf.minY);
    shape.lineTo(surf.maxX, -surf.maxY);
    shape.lineTo(surf.minX, -surf.maxY);
    shape.closePath();

    if (
      surf.shape === 'ring' &&
      surf.holeMinX !== undefined &&
      surf.holeMaxX !== undefined &&
      surf.holeMinY !== undefined &&
      surf.holeMaxY !== undefined
    ) {
      const hole = new THREE.Path();
      hole.moveTo(surf.holeMinX, -surf.holeMinY);
      hole.lineTo(surf.holeMinX, -surf.holeMaxY);
      hole.lineTo(surf.holeMaxX, -surf.holeMaxY);
      hole.lineTo(surf.holeMaxX, -surf.holeMinY);
      hole.closePath();
      shape.holes.push(hole);
    }
  }
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

function createDirectionalChevron(size: number, color: number, opacity: number): THREE.Line {
  const pts = [
    new THREE.Vector3(-size * 0.45, 0, -size * 0.45),
    new THREE.Vector3(size * 0.5, 0, 0),
    new THREE.Vector3(-size * 0.45, 0, size * 0.45),
  ];
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
  return new THREE.Line(geo, mat);
}

export class CadSceneController {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly rig: CadCameraRig;

  private container: HTMLElement;
  private rafId = 0;
  private lastTime = 0;
  private disposed = false;

  private referenceGroup = new THREE.Group();
  private modulesGroup = new THREE.Group();
  private buildingsGroup = new THREE.Group();
  private undergroundGroup = new THREE.Group();
  private previewGroup = new THREE.Group();
  private boxSelectGroup = new THREE.Group();
  private roundedGrid: ReturnType<typeof createRoundedGridOverlay>;

  private keysDown = new Set<string>();
  private lastState: SceneRenderState | null = null;

  constructor(
    container: HTMLElement,
    callbacks: {
      onAutoViewModeChange?: (mode: ViewMode) => void;
      onTelemetryChange?: (info: { yawDeg: number; pitchDeg: number; distance: number }) => void;
    } = {}
  ) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(COLORS.bg, 1);
    this.renderer.setSize(container.clientWidth || 800, container.clientHeight || 600);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(COLORS.bg, 0.0014);

    // Subtle crisp architectural lighting (zero flashy specular gaming look)
    const hemi = new THREE.HemisphereLight(0xdbeafe, 0x0f172a, 1.05);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xe2e8f0, 0.55);
    dir.position.set(60, 140, 80);
    this.scene.add(dir);

    this.rig = new CadCameraRig(
      (container.clientWidth || 800) / Math.max(1, container.clientHeight || 600),
      callbacks
    );

    this.roundedGrid = createRoundedGridOverlay();
    this.scene.add(this.referenceGroup);
    this.scene.add(this.modulesGroup);
    this.scene.add(this.buildingsGroup);
    this.scene.add(this.undergroundGroup);
    this.scene.add(this.roundedGrid.mesh);
    this.scene.add(this.previewGroup);
    this.scene.add(this.boxSelectGroup);

    this.buildMinimalReferenceAxes();
    this.lastTime = performance.now();
    this.tick(this.lastTime);
  }

  private buildMinimalReferenceAxes(): void {
    // Ultra-clean sparse 16m station reference ticks (never dense or noisy!)
    const pts: number[] = [];
    const extent = 16 * 12;
    // Origin crosshairs only
    pts.push(-extent, 0, 0, extent, 0, 0);
    pts.push(0, 0, -extent, 0, 0, extent);

    // Subtle + tick marks every 16m
    for (let gx = -8; gx <= 8; gx++) {
      for (let gz = -8; gz <= 8; gz++) {
        if (gx === 0 && gz === 0) continue;
        const x = gx * STATION_UNIT_M;
        const z = gz * STATION_UNIT_M;
        pts.push(x - 0.6, 0, z, x + 0.6, 0, z);
        pts.push(x, 0, z - 0.6, x, 0, z + 0.6);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const mat = new THREE.LineBasicMaterial({
      color: COLORS.refAxisX,
      transparent: true,
      opacity: 0.45,
    });
    this.referenceGroup.add(new THREE.LineSegments(geo, mat));
  }

  resize(): void {
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 600;
    this.renderer.setSize(w, h);
    this.rig.setAspect(w / Math.max(1, h));
  }

  setKeyDown(code: string, down: boolean): void {
    if (down) this.keysDown.add(code);
    else this.keysDown.delete(code);
  }

  clearKeys(): void {
    this.keysDown.clear();
  }

  syncState(state: SceneRenderState): void {
    const prev = this.lastState;
    this.lastState = state;

    this.rig.setFocusFloor(state.focusFloor);
    this.referenceGroup.position.y = state.focusFloor * FLOOR_VISUAL_SPACING - 0.06;

    const rebuildWorld =
      !prev ||
      prev.doc !== state.doc ||
      prev.focusFloor !== state.focusFloor ||
      prev.hideAbove !== state.hideAbove ||
      prev.viewMode !== state.viewMode ||
      prev.selection !== state.selection;

    if (rebuildWorld) {
      this.rebuildModules(state);
      this.rebuildBuildings(state);
    }

    this.updateRoundedGrid(state);
    this.rebuildPreview(state);
    this.rebuildBoxSelect(state);
  }

  private clearGroup(group: THREE.Group): void {
    while (group.children.length > 0) {
      const child = group.children.pop()!;
      child.traverse((obj) => {
        if ((obj as THREE.Mesh).geometry) {
          (obj as THREE.Mesh).geometry.dispose();
        }
        const mat = (obj as THREE.Mesh).material;
        if (Array.isArray(mat)) {
          mat.forEach((m) => m.dispose());
        } else if (mat) {
          mat.dispose();
        }
      });
    }
  }

  private layerOpacityFor(floor: number, focusFloor: number, hideAbove: boolean): number {
    if (floor > focusFloor) return hideAbove ? 0 : 0.16;
    if (floor === focusFloor) return 1.0;
    const dist = focusFloor - floor;
    return Math.max(0.24, 0.56 - dist * 0.12);
  }

  private rebuildModules(state: SceneRenderState): void {
    this.clearGroup(this.modulesGroup);
    const selectedMods = new Set(state.selection.moduleIds);

    for (const mod of state.doc.modules) {
      const def = getModuleDef(mod.type);
      if (!def) continue;

      const baseOpacity = this.layerOpacityFor(mod.floor, state.focusFloor, state.hideAbove);
      const upperFloor = mod.floor + def.sizeUnits[2] - 1;
      const spansFocus = state.focusFloor >= mod.floor && state.focusFloor <= upperFloor;
      const effectiveOpacity = spansFocus ? 1.0 : baseOpacity;
      if (effectiveOpacity <= 0.01) continue;

      const isSelected = selectedMods.has(mod.id);
      const group = this.buildStationPlatformMesh(mod, def, state, effectiveOpacity, isSelected);
      this.modulesGroup.add(group);
    }
  }

  private buildStationPlatformMesh(
    mod: PlacedModule,
    def: StationModuleDef,
    state: SceneRenderState,
    opacity: number,
    isSelected: boolean
  ): THREE.Group {
    const group = new THREE.Group();
    const [cx, cy] = getModuleCenterM(mod, def);
    const [wu, du, hu] = getModuleSizeUnits(def, mod.rotation);
    const wM = wu * STATION_UNIT_M;
    const dM = du * STATION_UNIT_M;
    const baseY = mod.floor * FLOOR_VISUAL_SPACING;
    const slabThickness = 0.45;
    const isTransparent = opacity < 0.99;

    // 1. Flat Shapez-2-inspired dark CAD platform slab
    const slabGeo = new THREE.BoxGeometry(wM - 0.16, slabThickness, dM - 0.16);
    const slabMat = new THREE.MeshLambertMaterial({
      color: def.hasFactoryFloor ? COLORS.slabFill : 0x111722,
      transparent: isTransparent,
      opacity: opacity * 0.96,
    });
    const slab = new THREE.Mesh(slabGeo, slabMat);
    slab.position.set(cx, baseY - slabThickness / 2 - 0.02, cy);
    group.add(slab);

    // Crisp outer platform CAD linework
    const edges = new THREE.EdgesGeometry(slabGeo);
    const edgeMat = new THREE.LineBasicMaterial({
      color: isSelected ? COLORS.slabEdgeSelected : COLORS.slabEdge,
      transparent: isTransparent,
      opacity,
    });
    const edgeLines = new THREE.LineSegments(edges, edgeMat);
    edgeLines.position.copy(slab.position);
    group.add(edgeLines);

    // 2. Buildable floor surface(s) (including 2x2 B L+1 ring balcony!)
    for (const surf of def.floors) {
      const surfFloor = mod.floor + surf.floorOffset;
      const surfOpacity = this.layerOpacityFor(surfFloor, state.focusFloor, state.hideAbove);
      if (surfOpacity <= 0.01) continue;
      const surfY = surfFloor * FLOOR_VISUAL_SPACING;

      const floorGeo = createFloorShapeGeometry(surf);
      const floorMat = new THREE.MeshBasicMaterial({
        color: surf.floorOffset > 0 ? COLORS.floorBalconyFill : COLORS.floorFill,
        transparent: surfOpacity < 0.99 || surf.floorOffset > 0,
        opacity: surfOpacity * (surf.floorOffset > 0 ? 0.92 : 0.96),
        side: THREE.DoubleSide,
      });
      const floorMesh = new THREE.Mesh(floorGeo, floorMat);
      floorMesh.position.set(cx, surfY + 0.005, cy);
      floorMesh.rotation.y = -mod.rotation * (Math.PI / 2);
      group.add(floorMesh);

      // Floor inner border linework
      const borderGeo = new THREE.EdgesGeometry(floorGeo);
      const borderMat = new THREE.LineBasicMaterial({
        color: surf.floorOffset > 0 ? 0x38bdf8 : COLORS.floorEdge,
        transparent: true,
        opacity: surfOpacity * (surf.floorOffset > 0 ? 0.65 : 0.8),
      });
      const borderLine = new THREE.LineSegments(borderGeo, borderMat);
      borderLine.position.copy(floorMesh.position);
      borderLine.rotation.copy(floorMesh.rotation);
      group.add(borderLine);

      // Doorway opening threshold ticks (only useful station interface markers!)
      for (const dw of surf.doorways) {
        const span = dw.end - dw.start;
        const mid = (dw.start + dw.end) / 2;
        const halfW = (def.sizeUnits[0] * STATION_UNIT_M) / 2;
        const halfD = (def.sizeUnits[1] * STATION_UNIT_M) / 2;
        let lx = 0;
        let lz = 0;
        let lenX = 0.22;
        let lenZ = 0.22;
        if (dw.side === 'E') { lx = halfW - 0.15; lz = mid; lenZ = span; }
        else if (dw.side === 'W') { lx = -halfW + 0.15; lz = mid; lenZ = span; }
        else if (dw.side === 'S') { lx = mid; lz = halfD - 0.15; lenX = span; }
        else { lx = mid; lz = -halfD + 0.15; lenX = span; }

        const dwGeo = new THREE.PlaneGeometry(lenX, lenZ);
        dwGeo.rotateX(-Math.PI / 2);
        const dwMat = new THREE.MeshBasicMaterial({
          color: span > 10 ? COLORS.connXLarge : COLORS.connLarge,
          transparent: true,
          opacity: surfOpacity * 0.45,
          side: THREE.DoubleSide,
        });
        const dwMesh = new THREE.Mesh(dwGeo, dwMat);
        // Apply module rotation around center
        const holder = new THREE.Group();
        holder.position.set(cx, surfY + 0.02, cy);
        holder.rotation.y = -mod.rotation * (Math.PI / 2);
        dwMesh.position.set(lx, 0, lz);
        holder.add(dwMesh);
        group.add(holder);
      }
    }

    // 3. Double-height modules: ultra-thin vertical CAD corner guides up to L+1 (zero walls!)
    if (hu > 1) {
      const topY = (mod.floor + hu - 1) * FLOOR_VISUAL_SPACING;
      const topOpacity = this.layerOpacityFor(mod.floor + hu - 1, state.focusFloor, state.hideAbove);
      const guideOpacity = Math.max(opacity * 0.35, topOpacity * 0.55);
      if (guideOpacity > 0.03) {
        const hw = wM / 2 - 0.25;
        const hd = dM / 2 - 0.25;
        const pts = [
          // 4 vertical corner hairlines
          cx - hw, baseY, cy - hd, cx - hw, topY, cy - hd,
          cx + hw, baseY, cy - hd, cx + hw, topY, cy - hd,
          cx + hw, baseY, cy + hd, cx + hw, topY, cy + hd,
          cx - hw, baseY, cy + hd, cx - hw, topY, cy + hd,
          // Top perimeter frame at L+1
          cx - hw, topY, cy - hd, cx + hw, topY, cy - hd,
          cx + hw, topY, cy - hd, cx + hw, topY, cy + hd,
          cx + hw, topY, cy + hd, cx - hw, topY, cy + hd,
          cx - hw, topY, cy + hd, cx - hw, topY, cy - hd,
        ];
        const gGeo = new THREE.BufferGeometry();
        gGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        const gMat = new THREE.LineBasicMaterial({
          color: isSelected ? COLORS.slabEdgeSelected : COLORS.heightFrame,
          transparent: true,
          opacity: guideOpacity,
        });
        group.add(new THREE.LineSegments(gGeo, gMat));
      }
    }

    // 4. Station Connectors (clean technical notch symbols!)
    const worldConns = getModuleWorldConnectors(mod, def);
    for (const c of worldConns) {
      const cOpacity = this.layerOpacityFor(c.floor, state.focusFloor, state.hideAbove);
      if (cOpacity <= 0.01) continue;
      const cyWorld = c.floor * FLOOR_VISUAL_SPACING + 0.06;

      if (c.type.startsWith('Vertical')) {
        // Vertical shaft diamond ring
        const r = c.type === 'Vertical2x2' ? 3.2 : 1.7;
        const pts = [
          new THREE.Vector3(c.x, cyWorld, c.y - r),
          new THREE.Vector3(c.x + r, cyWorld, c.y),
          new THREE.Vector3(c.x, cyWorld, c.y + r),
          new THREE.Vector3(c.x - r, cyWorld, c.y),
          new THREE.Vector3(c.x, cyWorld, c.y - r),
        ];
        const vGeo = new THREE.BufferGeometry().setFromPoints(pts);
        const vMat = new THREE.LineBasicMaterial({
          color: COLORS.connVertical,
          transparent: true,
          opacity: cOpacity * 0.85,
        });
        group.add(new THREE.Line(vGeo, vMat));
      } else {
        const isXL = c.type === 'XLarge';
        const span = isXL ? 18 : 5.2;
        const col = isXL ? COLORS.connXLarge : COLORS.connLarge;
        const barGeo = new THREE.BoxGeometry(0.42, 0.14, span);
        const barMat = new THREE.MeshBasicMaterial({
          color: col,
          transparent: true,
          opacity: cOpacity * (state.viewMode === 'station' ? 0.88 : 0.45),
        });
        const bar = new THREE.Mesh(barGeo, barMat);
        bar.position.set(c.x, cyWorld, c.y);
        bar.rotation.y = -c.rotation * (Math.PI / 2);
        group.add(bar);
      }
    }

    // 5. Station Overview label (subtle schematic caption in Station View)
    if (state.viewMode === 'station' && opacity >= 0.5) {
      const tex = getLabelTexture(def.nameZh, mod.label || (hu > 1 ? `${hu}层高` : null));
      const labelW = Math.min(wM * 0.72, 16);
      const labelGeo = new THREE.PlaneGeometry(labelW, labelW * 0.5);
      labelGeo.rotateX(-Math.PI / 2);
      const labelMat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        opacity: opacity * 0.85,
        depthWrite: false,
      });
      const labelMesh = new THREE.Mesh(labelGeo, labelMat);
      labelMesh.position.set(cx, baseY + 0.08, cy);
      group.add(labelMesh);
    }

    return group;
  }

  private rebuildBuildings(state: SceneRenderState): void {
    this.clearGroup(this.buildingsGroup);
    this.clearGroup(this.undergroundGroup);
    const selectedBlds = new Set(state.selection.buildingIds);

    for (const b of state.doc.buildings) {
      const def = getBuildableDef(b.type);
      if (!def) continue;
      const opacity = this.layerOpacityFor(b.floor, state.focusFloor, state.hideAbove);
      if (opacity <= 0.01) continue;
      const isSelected = selectedBlds.has(b.id);
      const mesh = this.buildBuildingMesh(b, def, state, opacity, isSelected);
      this.buildingsGroup.add(mesh);
    }

    // Draw subtle subterranean dashed links for paired underground belts
    const links = computeUndergroundLinks(state.doc);
    for (const link of links) {
      const opacity = this.layerOpacityFor(link.floor, state.focusFloor, state.hideAbove);
      if (opacity <= 0.01) continue;
      const y = link.floor * FLOOR_VISUAL_SPACING + 0.12;
      const pts = [new THREE.Vector3(link.x1, y, link.y1), new THREE.Vector3(link.x2, y, link.y2)];
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineDashedMaterial({
        color: link.tier === 3 ? COLORS.beltMk3 : link.tier === 2 ? COLORS.beltMk2 : COLORS.beltMk1,
        dashSize: 0.35,
        gapSize: 0.25,
        transparent: true,
        opacity: opacity * 0.85,
      });
      const line = new THREE.Line(geo, mat);
      line.computeLineDistances();
      this.undergroundGroup.add(line);
    }
  }

  private buildBuildingMesh(
    b: PlacedBuilding,
    def: BuildableDef,
    state: SceneRenderState,
    opacity: number,
    isSelected: boolean
  ): THREE.Group {
    const group = new THREE.Group();
    const [cx, cy] = getBuildingCenterM(b, def);
    const [w, d] = getBuildingSizeCells(def, b.rotation);
    const baseY = b.floor * FLOOR_VISUAL_SPACING;
    const isTransparent = opacity < 0.99;

    const accent = isSelected ? COLORS.selectOutline : buildingAccentColor(def);
    const fill = buildingFillColor(def);

    if (def.kind === 'belt') {
      // Sleek minimal CAD belt strip
      const h = 0.16;
      const geo = new THREE.BoxGeometry(0.84, h, 0.84);
      const mat = new THREE.MeshLambertMaterial({ color: fill, transparent: isTransparent, opacity });
      const box = new THREE.Mesh(geo, mat);
      box.position.set(cx, baseY + h / 2 + 0.01, cy);
      group.add(box);

      const edges = new THREE.EdgesGeometry(geo);
      const edgeLine = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: opacity * (isSelected ? 1 : 0.72) })
      );
      edgeLine.position.copy(box.position);
      group.add(edgeLine);

      // Directional chevron on belt
      const chevron = createDirectionalChevron(0.46, isSelected ? 0xffffff : accent, opacity * 0.95);
      chevron.position.set(cx, baseY + h + 0.03, cy);
      chevron.rotation.y = -b.rotation * (Math.PI / 2);
      group.add(chevron);
      return group;
    }

    // Simplified architectural massing block for machines / containers / splitters / undergrounds
    const visH =
      def.kind === 'underground' ? 0.42
        : def.kind === 'splitter' || def.kind === 'balancer' ? 0.36
        : def.kind === 'container' ? 0.85
        : Math.min(2.4, Math.max(0.75, def.heightM * 0.42));

    const inset = def.size[0] >= 3 ? 0.14 : 0.1;
    const boxGeo = new THREE.BoxGeometry(w - inset, visH, d - inset);
    const boxMat = new THREE.MeshLambertMaterial({
      color: fill,
      transparent: isTransparent,
      opacity: opacity * 0.95,
    });
    const mesh = new THREE.Mesh(boxGeo, boxMat);
    mesh.position.set(cx, baseY + visH / 2 + 0.01, cy);
    group.add(mesh);

    const edges = new THREE.EdgesGeometry(boxGeo);
    const edgeLine = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({
        color: accent,
        transparent: isTransparent,
        opacity: opacity * (isSelected ? 1.0 : 0.82),
      })
    );
    edgeLine.position.copy(mesh.position);
    group.add(edgeLine);

    // Direction marker for directional buildings (splitters, balancers, undergrounds, labs)
    if (['underground', 'splitter', 'balancer', 'research'].includes(def.kind)) {
      const chevSize = def.kind === 'research' ? 0.8 : 0.48;
      const chevColor = def.kind === 'underground' && b.undergroundMode === 'out' ? 0x22c55e : accent;
      const chevron = createDirectionalChevron(chevSize, chevColor, opacity);
      chevron.position.set(cx, baseY + visH + 0.04, cy);
      chevron.rotation.y = -b.rotation * (Math.PI / 2);
      group.add(chevron);
    }

    // Machine ports: Bright Green (active) vs Dim Red (disabled)!
    if (def.configurablePorts || def.kind === 'splitter' || def.kind === 'balancer') {
      const worldPorts = getBuildingWorldPorts(b, def);
      for (const wp of worldPorts) {
        const pGeo = new THREE.BoxGeometry(0.32, 0.24, 0.32);
        const pColor = wp.enabled ? COLORS.portActive : COLORS.portDisabled;
        const pMat = new THREE.MeshBasicMaterial({
          color: pColor,
          transparent: true,
          opacity: opacity * (wp.enabled ? 0.95 : 0.55),
        });
        const pMesh = new THREE.Mesh(pGeo, pMat);
        pMesh.position.set(wp.worldX, baseY + 0.2, wp.worldY);
        group.add(pMesh);

        // Crisp rim for disabled ports so dim red stays legible on dark slate
        if (!wp.enabled) {
          const rGeo = new THREE.EdgesGeometry(pGeo);
          const rLine = new THREE.LineSegments(
            rGeo,
            new THREE.LineBasicMaterial({ color: COLORS.portDisabledRim, transparent: true, opacity: opacity * 0.7 })
          );
          rLine.position.copy(pMesh.position);
          group.add(rLine);
        }
      }
    }

    // Crisp flat top-face label in Building View for machines >= 2x2
    if (state.viewMode === 'building' && Math.min(w, d) >= 2 && opacity >= 0.45) {
      const recipe = b.recipeId ? getRecipeDef(b.recipeId) : null;
      const subtitle = b.label || recipe?.nameZh || null;
      const tex = getLabelTexture(def.nameZh, subtitle);
      const labelW = Math.min(w - 0.3, 4.6);
      const labelGeo = new THREE.PlaneGeometry(labelW, labelW * 0.5);
      labelGeo.rotateX(-Math.PI / 2);
      const labelMat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        opacity: opacity * 0.92,
        depthWrite: false,
      });
      const labelMesh = new THREE.Mesh(labelGeo, labelMat);
      labelMesh.position.set(cx, baseY + visH + 0.03, cy);
      group.add(labelMesh);
    }

    return group;
  }

  private updateRoundedGrid(state: SceneRenderState): void {
    const u = this.roundedGrid.uniforms;
    this.roundedGrid.mesh.position.y = state.focusFloor * FLOOR_VISUAL_SPACING + 0.025;

    const isStation = state.viewMode === 'station';
    u.uCellSize.value = isStation ? STATION_UNIT_M : 1.0;
    u.uCursorRadius.value = isStation ? 44.0 : 7.5;
    u.uCornerRadius.value = isStation ? 0.06 : 0.13;

    // Only show local rounded grid when hovering / placing / box-selecting / belt-dragging
    const showForTool = state.activeTool.kind !== 'select' || state.boxSelectRect !== null || state.beltPreview.length > 0;
    if (state.cursorWorld) {
      u.uCursorWorld.value.set(state.cursorWorld.x, state.cursorWorld.y);
      u.uCursorActive.value = 1.0;
      u.uOpacity.value = showForTool ? 0.92 : (isStation ? 0.48 : 0.65);
    } else {
      u.uCursorActive.value = 0.0;
    }

    if (state.boxSelectRect) {
      u.uFocusRect.value.set(
        state.boxSelectRect.minX,
        state.boxSelectRect.minY,
        state.boxSelectRect.maxX,
        state.boxSelectRect.maxY
      );
      u.uHasFocusRect.value = 1.0;
    } else if (state.beltPreview.length > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const s of state.beltPreview) {
        minX = Math.min(minX, s.x);
        minY = Math.min(minY, s.y);
        maxX = Math.max(maxX, s.x + 1);
        maxY = Math.max(maxY, s.y + 1);
      }
      u.uFocusRect.value.set(minX, minY, maxX, maxY);
      u.uHasFocusRect.value = 1.0;
    } else if (state.cursorWorld && state.activeTool.kind === 'place-building') {
      const def = getBuildableDef(state.activeTool.buildingType);
      if (def) {
        const [w, d] = getBuildingSizeCells(def, state.activeTool.rotation);
        const bx = Math.floor(state.cursorWorld.x - w / 2 + 0.5);
        const by = Math.floor(state.cursorWorld.y - d / 2 + 0.5);
        u.uFocusRect.value.set(bx, by, bx + w, by + d);
        u.uHasFocusRect.value = 1.0;
      } else {
        u.uHasFocusRect.value = 0.0;
      }
    } else if (state.cursorWorld && state.activeTool.kind === 'stamp-blueprint') {
      const bounds = getBlueprintBoundsM(state.activeTool.blueprint);
      const hasMods = state.activeTool.blueprint.modules.length > 0;
      const ax = hasMods
        ? Math.floor(state.cursorWorld.x / STATION_UNIT_M) * STATION_UNIT_M
        : Math.floor(state.cursorWorld.x);
      const ay = hasMods
        ? Math.floor(state.cursorWorld.y / STATION_UNIT_M) * STATION_UNIT_M
        : Math.floor(state.cursorWorld.y);
      u.uFocusRect.value.set(ax, ay, ax + bounds.width, ay + bounds.depth);
      u.uHasFocusRect.value = 1.0;
    } else {
      u.uHasFocusRect.value = 0.0;
    }
  }

  private rebuildPreview(state: SceneRenderState): void {
    this.clearGroup(this.previewGroup);

    // 1. Active belt drag / Belt Planner preview
    if (state.beltPreview.length > 0 && state.activeTool.kind === 'place-building') {
      const beltType = state.activeTool.buildingType;
      const baseY = state.focusFloor * FLOOR_VISUAL_SPACING;
      for (const seg of state.beltPreview) {
        const issue = validateBuildingPlacement(
          state.doc,
          { type: beltType, x: seg.x, y: seg.y, floor: state.focusFloor, rotation: seg.rotation },
          { allowBeltReplace: true }
        );
        const col = issue ? COLORS.invalidGhost : COLORS.validGhost;
        const geo = new THREE.BoxGeometry(0.84, 0.18, 0.84);
        const mesh = new THREE.Mesh(
          geo,
          new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.35 })
        );
        mesh.position.set(seg.x + 0.5, baseY + 0.12, seg.y + 0.5);
        this.previewGroup.add(mesh);

        const chev = createDirectionalChevron(0.46, col, 0.95);
        chev.position.set(seg.x + 0.5, baseY + 0.24, seg.y + 0.5);
        chev.rotation.y = -seg.rotation * (Math.PI / 2);
        this.previewGroup.add(chev);
      }
      return;
    }

    if (!state.cursorWorld) return;
    const baseY = state.focusFloor * FLOOR_VISUAL_SPACING;

    // 2. Single Station Module placement ghost
    if (state.activeTool.kind === 'place-module') {
      const def = getModuleDef(state.activeTool.moduleType);
      if (!def) return;
      const [wu, du, hu] = getModuleSizeUnits(def, state.activeTool.rotation);
      const gx = Math.floor(state.cursorWorld.x / STATION_UNIT_M);
      const gy = Math.floor(state.cursorWorld.y / STATION_UNIT_M);
      const issue = validateModulePlacement(state.doc, {
        type: def.id,
        gx,
        gy,
        floor: state.focusFloor,
        rotation: state.activeTool.rotation,
      });
      const col = issue ? COLORS.invalidGhost : COLORS.validGhost;
      const wM = wu * STATION_UNIT_M;
      const dM = du * STATION_UNIT_M;
      const cx = (gx + wu / 2) * STATION_UNIT_M;
      const cy = (gy + du / 2) * STATION_UNIT_M;
      const hVis = hu > 1 ? FLOOR_VISUAL_SPACING : 0.6;
      const geo = new THREE.BoxGeometry(wM - 0.15, hVis, dM - 0.15);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.16 })
      );
      mesh.position.set(cx, baseY + hVis / 2 - 0.2, cy);
      this.previewGroup.add(mesh);
      const line = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: col })
      );
      line.position.copy(mesh.position);
      this.previewGroup.add(line);
      return;
    }

    // 3. Single Building placement ghost
    if (state.activeTool.kind === 'place-building') {
      const def = getBuildableDef(state.activeTool.buildingType);
      if (!def) return;
      const [w, d] = getBuildingSizeCells(def, state.activeTool.rotation);
      const bx = Math.floor(state.cursorWorld.x - w / 2 + 0.5);
      const by = Math.floor(state.cursorWorld.y - d / 2 + 0.5);
      const issue = validateBuildingPlacement(
        state.doc,
        { type: def.id, x: bx, y: by, floor: state.focusFloor, rotation: state.activeTool.rotation },
        { allowBeltReplace: def.kind === 'belt', allowForceReplace: state.forceReplaceHeld }
      );
      const col = issue ? COLORS.invalidGhost : COLORS.validGhost;
      const visH = def.kind === 'belt' ? 0.2 : Math.min(2.2, Math.max(0.5, def.heightM * 0.4));
      const geo = new THREE.BoxGeometry(w - 0.12, visH, d - 0.12);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.22 })
      );
      mesh.position.set(bx + w / 2, baseY + visH / 2 + 0.02, by + d / 2);
      this.previewGroup.add(mesh);
      const line = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: col })
      );
      line.position.copy(mesh.position);
      this.previewGroup.add(line);

      // Show direction arrow on ghost
      const chev = createDirectionalChevron(Math.min(w, d) * 0.42, col, 1);
      chev.position.set(bx + w / 2, baseY + visH + 0.06, by + d / 2);
      chev.rotation.y = -state.activeTool.rotation * (Math.PI / 2);
      this.previewGroup.add(chev);

      // Show underground max-range guide line (up to 8 cells)
      if (def.kind === 'underground') {
        const maxLen = def.maxLength ?? 8;
        const dirSign = state.activeTool.undergroundMode === 'out' ? -1 : 1;
        const dx = state.activeTool.rotation === 0 ? 1 : state.activeTool.rotation === 2 ? -1 : 0;
        const dy = state.activeTool.rotation === 1 ? 1 : state.activeTool.rotation === 3 ? -1 : 0;
        const pts = [
          new THREE.Vector3(bx + 0.5, baseY + 0.15, by + 0.5),
          new THREE.Vector3(bx + 0.5 + dx * dirSign * maxLen, baseY + 0.15, by + 0.5 + dy * dirSign * maxLen),
        ];
        const lGeo = new THREE.BufferGeometry().setFromPoints(pts);
        const lMat = new THREE.LineDashedMaterial({ color: col, dashSize: 0.4, gapSize: 0.25 });
        const guide = new THREE.Line(lGeo, lMat);
        guide.computeLineDistances();
        this.previewGroup.add(guide);
      }
      return;
    }

    // 4. Blueprint Stamp Ghost (multi-module & multi-layer shapez 2 style!)
    if (state.activeTool.kind === 'stamp-blueprint') {
      const anchorX = Math.floor(state.cursorWorld.x);
      const anchorY = Math.floor(state.cursorWorld.y);
      const anchorFloor = state.focusFloor + state.activeTool.floorOffset;
      const { modules, buildings } = computeStampCandidates(state.activeTool.blueprint, {
        x: anchorX,
        y: anchorY,
        floor: anchorFloor,
      });

      // Build temp doc including valid candidate modules so building checks recognize newly stamped floors!
      const tempDoc: BlueprintDocument = {
        ...state.doc,
        modules: [...state.doc.modules, ...modules],
      };

      for (const m of modules) {
        const def = getModuleDef(m.type);
        if (!def) continue;
        const issue = validateModulePlacement(state.doc, m);
        const col = issue && !state.forceReplaceHeld ? COLORS.invalidGhost : COLORS.validGhost;
        const [minX, minY, maxX, maxY] = getModuleBoundsM(m, def);
        const y = m.floor * FLOOR_VISUAL_SPACING;
        const geo = new THREE.BoxGeometry(maxX - minX - 0.2, 0.5, maxY - minY - 0.2);
        const mesh = new THREE.Mesh(
          geo,
          new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.18 })
        );
        mesh.position.set((minX + maxX) / 2, y, (minY + maxY) / 2);
        this.previewGroup.add(mesh);
        const line = new THREE.LineSegments(
          new THREE.EdgesGeometry(geo),
          new THREE.LineBasicMaterial({ color: col })
        );
        line.position.copy(mesh.position);
        this.previewGroup.add(line);
      }

      for (const b of buildings) {
        const def = getBuildableDef(b.type);
        if (!def) continue;
        const issue = validateBuildingPlacement(tempDoc, b, {
          allowBeltReplace: true,
          allowForceReplace: state.forceReplaceHeld,
        });
        const col = issue ? COLORS.invalidGhost : COLORS.validGhost;
        const [w, d] = getBuildingSizeCells(def, b.rotation);
        const y = b.floor * FLOOR_VISUAL_SPACING;
        const visH = def.kind === 'belt' ? 0.2 : 0.9;
        const geo = new THREE.BoxGeometry(w - 0.12, visH, d - 0.12);
        const mesh = new THREE.Mesh(
          geo,
          new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.28 })
        );
        mesh.position.set(b.x + w / 2, y + visH / 2 + 0.02, b.y + d / 2);
        this.previewGroup.add(mesh);
        const line = new THREE.LineSegments(
          new THREE.EdgesGeometry(geo),
          new THREE.LineBasicMaterial({ color: col })
        );
        line.position.copy(mesh.position);
        this.previewGroup.add(line);
      }
    }
  }

  private rebuildBoxSelect(state: SceneRenderState): void {
    this.clearGroup(this.boxSelectGroup);
    if (!state.boxSelectRect) return;
    const { minX, minY, maxX, maxY } = state.boxSelectRect;
    const w = Math.max(0.2, maxX - minX);
    const d = Math.max(0.2, maxY - minY);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    // Show 3D vertical span reflecting multi-layer box selection mode!
    let lowFloor = state.focusFloor;
    let highFloor = state.focusFloor;
    if (state.selectionLayerMode === 'visible') {
      lowFloor = Math.min(0, state.focusFloor);
      highFloor = state.hideAbove ? state.focusFloor : Math.max(state.focusFloor + 2, 2);
    } else if (state.selectionLayerMode === 'all') {
      lowFloor = Math.min(0, state.focusFloor);
      highFloor = Math.max(state.focusFloor + 2, 3);
    }

    const y0 = lowFloor * FLOOR_VISUAL_SPACING - 0.2;
    const y1 = highFloor * FLOOR_VISUAL_SPACING + 2.8;
    const h = Math.max(2.6, y1 - y0);

    const geo = new THREE.BoxGeometry(w, h, d);
    const fill = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.09, depthWrite: false })
    );
    fill.position.set(cx, (y0 + y1) / 2, cy);
    this.boxSelectGroup.add(fill);

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.9 })
    );
    edges.position.copy(fill.position);
    this.boxSelectGroup.add(edges);
  }

  private tick = (now: number): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.tick);
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;

    // Smooth WASD panning
    let right = 0;
    let forward = 0;
    if (this.keysDown.has('KeyD') || this.keysDown.has('ArrowRight')) right += 1;
    if (this.keysDown.has('KeyA') || this.keysDown.has('ArrowLeft')) right -= 1;
    if (this.keysDown.has('KeyW') || this.keysDown.has('ArrowUp')) forward += 1;
    if (this.keysDown.has('KeyS') || this.keysDown.has('ArrowDown')) forward -= 1;
    if (right !== 0 || forward !== 0) {
      this.rig.panByAxes(right, forward, dt);
    }

    this.rig.update(dt, now);
    this.renderer.render(this.scene, this.rig.camera);
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    this.clearGroup(this.referenceGroup);
    this.clearGroup(this.modulesGroup);
    this.clearGroup(this.buildingsGroup);
    this.clearGroup(this.undergroundGroup);
    this.clearGroup(this.previewGroup);
    this.clearGroup(this.boxSelectGroup);
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
