import * as THREE from 'three';
import { getBuildableDef, getModuleDef, getRecipeDef } from '../core/catalog';
import { computeStampCandidates, getBlueprintBoundsM } from '../core/commands';
import {
  computeUndergroundLinks,
  FLOOR_VISUAL_SPACING,
  getBuildingCenterM,
  getBuildingSizeCells,
  getModuleBoundsM,
  getModuleCenterM,
  getModuleSizeUnits,
  getModuleWorldConnectors,
  STATION_UNIT_M,
  validateBuildingPlacement,
  validateModulePlacement,
} from '../core/geometry';
import { getShortLabel } from '../core/groups';
import type {
  ActiveTool,
  BlueprintDocument,
  PlacedModule,
  Rotation,
  SelectionLayerMode,
  SelectionState,
  StationFloorSurfaceDef,
  StationModuleDef,
  ViewMode,
} from '../core/types';
import { CadCameraRig } from './camera-rig';
import { buildBeltLineArt, buildMachineLineArt } from './line-art';
import { createRoundedGridOverlay } from './rounded-grid-shader';

// Restrained Dark Precision CAD Line-Art Palette (zero loud neon / cheap color fills!)
const COLORS = {
  bg: 0x080b10,
  slabFill: 0x0c1119,
  slabEdge: 0x263244,
  slabEdgeSelected: 0x90aec8,
  floorFill: 0x0f1620,
  floorBalconyFill: 0x121c29,
  floorEdge: 0x243142,
  floorBalconyEdge: 0x3f556e,
  connLarge: 0x4b637c,
  connXLarge: 0x4e7378,
  connVertical: 0x675f85,
  validGhost: 0x9ec0de,
  invalidGhost: 0xc95b61,
  selectOutline: 0x9ab8d4,
  heightFrame: 0x222e3e,
  refAxis: 0x182332,
  undergroundLink: 0x4c637a,
};

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
  canvas.height = 96;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#8fa4ba';
  ctx.font = '500 22px "Segoe UI", "Microsoft YaHei", sans-serif';
  const yTitle = subtitle ? 32 : 48;
  ctx.fillText(title.slice(0, 10), 128, yTitle, 236);

  if (subtitle) {
    ctx.fillStyle = '#637a94';
    ctx.font = '400 18px "JetBrains Mono", Consolas, "Microsoft YaHei", monospace';
    ctx.fillText(subtitle.slice(0, 12), 128, 66, 236);
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

/** Hollow technical bracket for station connector (line-art only, no solid bar!) */
function createHollowConnectorBracket(span: number, color: number, opacity: number): THREE.LineSegments {
  const hs = span / 2;
  const d = 0.28;
  const pts = [
    -d, 0, -hs,  d, 0, -hs,
     d, 0, -hs,  d, 0,  hs,
     d, 0,  hs, -d, 0,  hs,
    -d, 0,  hs, -d, 0, -hs,
    // Center hairline tick
    -d * 1.4, 0, 0, d * 1.4, 0, 0,
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
  return new THREE.LineSegments(geo, mat);
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
    // Subtle dark depth attenuation so peripheral areas stay calm while focus stays crisp
    this.scene.fog = new THREE.FogExp2(COLORS.bg, 0.0021);

    const hemi = new THREE.HemisphereLight(0x9fb3c8, 0x080b10, 0.9);
    this.scene.add(hemi);

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
    const pts: number[] = [];
    const extent = 16 * 12;
    pts.push(-extent, 0, 0, extent, 0, 0);
    pts.push(0, 0, -extent, 0, 0, extent);

    for (let gx = -8; gx <= 8; gx++) {
      for (let gz = -8; gz <= 8; gz++) {
        if (gx === 0 && gz === 0) continue;
        const x = gx * STATION_UNIT_M;
        const z = gz * STATION_UNIT_M;
        pts.push(x - 0.5, 0, z, x + 0.5, 0, z);
        pts.push(x, 0, z - 0.5, x, 0, z + 0.5);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const mat = new THREE.LineBasicMaterial({
      color: COLORS.refAxis,
      transparent: true,
      opacity: 0.4,
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
    if (floor > focusFloor) return hideAbove ? 0 : 0.14;
    if (floor === focusFloor) return 1.0;
    const dist = focusFloor - floor;
    return Math.max(0.2, 0.48 - dist * 0.12);
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
      this.modulesGroup.add(this.buildStationPlatformMesh(mod, def, state, effectiveOpacity, isSelected));
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
    const slabThickness = 0.28;
    const isTransparent = opacity < 0.99;

    // 1. Sleek ultra-flat platform slab (dark matte obsidian-slate + quiet architectural rim)
    const slabGeo = new THREE.BoxGeometry(wM - 0.18, slabThickness, dM - 0.18);
    const slabMat = new THREE.MeshBasicMaterial({
      color: def.hasFactoryFloor ? COLORS.slabFill : 0x0a0f16,
      transparent: isTransparent,
      opacity: opacity * 0.96,
    });
    const slab = new THREE.Mesh(slabGeo, slabMat);
    slab.position.set(cx, baseY - slabThickness / 2 - 0.02, cy);
    group.add(slab);

    const edges = new THREE.EdgesGeometry(slabGeo);
    const edgeMat = new THREE.LineBasicMaterial({
      color: isSelected ? COLORS.slabEdgeSelected : COLORS.slabEdge,
      transparent: true,
      opacity: opacity * (isSelected ? 1.0 : 0.85),
    });
    const edgeLines = new THREE.LineSegments(edges, edgeMat);
    edgeLines.position.copy(slab.position);
    group.add(edgeLines);

    // 2. Buildable floor surface(s)
    for (const surf of def.floors) {
      const surfFloor = mod.floor + surf.floorOffset;
      const surfOpacity = this.layerOpacityFor(surfFloor, state.focusFloor, state.hideAbove);
      if (surfOpacity <= 0.01) continue;
      const surfY = surfFloor * FLOOR_VISUAL_SPACING;

      const floorGeo = createFloorShapeGeometry(surf);
      const floorMat = new THREE.MeshBasicMaterial({
        color: surf.floorOffset > 0 ? COLORS.floorBalconyFill : COLORS.floorFill,
        transparent: surfOpacity < 0.99 || surf.floorOffset > 0,
        opacity: surfOpacity * (surf.floorOffset > 0 ? 0.9 : 0.96),
        side: THREE.DoubleSide,
      });
      const floorMesh = new THREE.Mesh(floorGeo, floorMat);
      floorMesh.position.set(cx, surfY + 0.005, cy);
      floorMesh.rotation.y = -mod.rotation * (Math.PI / 2);
      group.add(floorMesh);

      const borderGeo = new THREE.EdgesGeometry(floorGeo);
      const borderMat = new THREE.LineBasicMaterial({
        color: surf.floorOffset > 0 ? COLORS.floorBalconyEdge : COLORS.floorEdge,
        transparent: true,
        opacity: surfOpacity * 0.85,
      });
      const borderLine = new THREE.LineSegments(borderGeo, borderMat);
      borderLine.position.copy(floorMesh.position);
      borderLine.rotation.copy(floorMesh.rotation);
      group.add(borderLine);

      // Subtle hairline doorway threshold indicators (unfilled lines!)
      for (const dw of surf.doorways) {
        const span = dw.end - dw.start;
        const mid = (dw.start + dw.end) / 2;
        const halfW = (def.sizeUnits[0] * STATION_UNIT_M) / 2;
        const halfD = (def.sizeUnits[1] * STATION_UNIT_M) / 2;
        const pts: number[] = [];
        if (dw.side === 'E') pts.push(halfW - 0.12, 0, dw.start, halfW - 0.12, 0, dw.end);
        else if (dw.side === 'W') pts.push(-halfW + 0.12, 0, dw.start, -halfW + 0.12, 0, dw.end);
        else if (dw.side === 'S') pts.push(dw.start, 0, halfD - 0.12, dw.end, 0, halfD - 0.12);
        else pts.push(dw.start, 0, -halfD + 0.12, dw.end, 0, -halfD + 0.12);

        const dwGeo = new THREE.BufferGeometry();
        dwGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        const dwLine = new THREE.LineSegments(
          dwGeo,
          new THREE.LineBasicMaterial({
            color: span > 10 ? COLORS.connXLarge : COLORS.connLarge,
            transparent: true,
            opacity: surfOpacity * 0.65,
          })
        );
        const holder = new THREE.Group();
        holder.position.set(cx, surfY + 0.02, cy);
        holder.rotation.y = -mod.rotation * (Math.PI / 2);
        holder.add(dwLine);
        group.add(holder);
        void mid;
      }
    }

    // 3. Double-height ultra-thin corner wireframe guides
    if (hu > 1) {
      const topY = (mod.floor + hu - 1) * FLOOR_VISUAL_SPACING;
      const topOpacity = this.layerOpacityFor(mod.floor + hu - 1, state.focusFloor, state.hideAbove);
      const guideOpacity = Math.max(opacity * 0.25, topOpacity * 0.45);
      if (guideOpacity > 0.03) {
        const hw = wM / 2 - 0.25;
        const hd = dM / 2 - 0.25;
        const pts = [
          cx - hw, baseY, cy - hd, cx - hw, topY, cy - hd,
          cx + hw, baseY, cy - hd, cx + hw, topY, cy - hd,
          cx + hw, baseY, cy + hd, cx + hw, topY, cy + hd,
          cx - hw, baseY, cy + hd, cx - hw, topY, cy + hd,
          cx - hw, topY, cy - hd, cx + hw, topY, cy - hd,
          cx + hw, topY, cy - hd, cx + hw, topY, cy + hd,
          cx + hw, topY, cy + hd, cx - hw, topY, cy + hd,
          cx - hw, topY, cy + hd, cx - hw, topY, cy - hd,
        ];
        const gGeo = new THREE.BufferGeometry();
        gGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        group.add(
          new THREE.LineSegments(
            gGeo,
            new THREE.LineBasicMaterial({
              color: isSelected ? COLORS.slabEdgeSelected : COLORS.heightFrame,
              transparent: true,
              opacity: guideOpacity,
            })
          )
        );
      }
    }

    // 4. Hollow line-art Station Connectors (zero cheap solid bars!)
    const worldConns = getModuleWorldConnectors(mod, def);
    for (const c of worldConns) {
      const cOpacity = this.layerOpacityFor(c.floor, state.focusFloor, state.hideAbove);
      if (cOpacity <= 0.01) continue;
      const cyWorld = c.floor * FLOOR_VISUAL_SPACING + 0.05;

      if (c.type.startsWith('Vertical')) {
        const r = c.type === 'Vertical2x2' ? 3.2 : 1.7;
        const pts = [
          new THREE.Vector3(c.x, cyWorld, c.y - r),
          new THREE.Vector3(c.x + r, cyWorld, c.y),
          new THREE.Vector3(c.x, cyWorld, c.y + r),
          new THREE.Vector3(c.x - r, cyWorld, c.y),
          new THREE.Vector3(c.x, cyWorld, c.y - r),
        ];
        const vGeo = new THREE.BufferGeometry().setFromPoints(pts);
        group.add(
          new THREE.Line(
            vGeo,
            new THREE.LineBasicMaterial({ color: COLORS.connVertical, transparent: true, opacity: cOpacity * 0.72 })
          )
        );
      } else {
        const isXL = c.type === 'XLarge';
        const span = isXL ? 18 : 5.2;
        const col = isXL ? COLORS.connXLarge : COLORS.connLarge;
        const bracket = createHollowConnectorBracket(
          span,
          col,
          cOpacity * (state.viewMode === 'station' ? 0.78 : 0.38)
        );
        bracket.position.set(c.x, cyWorld, c.y);
        bracket.rotation.y = -c.rotation * (Math.PI / 2);
        group.add(bracket);
      }
    }

    // 5. Minimal Station Overview caption
    if (state.viewMode === 'station' && opacity >= 0.5) {
      const shortName = getShortLabel(def.id, def.nameZh);
      const tex = getLabelTexture(shortName, mod.label || null);
      const labelW = Math.min(wM * 0.58, 12);
      const labelGeo = new THREE.PlaneGeometry(labelW, labelW * 0.375);
      labelGeo.rotateX(-Math.PI / 2);
      const labelMesh = new THREE.Mesh(
        labelGeo,
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: opacity * 0.78, depthWrite: false })
      );
      labelMesh.position.set(cx, baseY + 0.06, cy);
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
      const baseY = b.floor * FLOOR_VISUAL_SPACING;

      if (def.kind === 'belt') {
        this.buildingsGroup.add(buildBeltLineArt(state.doc, b, def, baseY, opacity, isSelected));
        continue;
      }

      const artGroup = buildMachineLineArt(b, def, baseY, opacity, isSelected);

      // Subtle flat top caption ONLY when a recipe or custom label is configured (keeps unconfigured line-art pure!)
      const recipe = b.recipeId ? getRecipeDef(b.recipeId) : null;
      const caption = b.label || recipe?.nameZh || null;
      const [w, d] = getBuildingSizeCells(def, b.rotation);
      if (state.viewMode === 'building' && caption && Math.min(w, d) >= 2 && opacity >= 0.45) {
        const [cx, cz] = getBuildingCenterM(b, def);
        const tex = getLabelTexture(caption, null);
        const labelW = Math.min(w - 0.4, 3.8);
        const labelGeo = new THREE.PlaneGeometry(labelW, labelW * 0.375);
        labelGeo.rotateX(-Math.PI / 2);
        const labelMesh = new THREE.Mesh(
          labelGeo,
          new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: opacity * 0.85, depthWrite: false })
        );
        labelMesh.position.set(cx, baseY + 0.085, cz);
        artGroup.add(labelMesh);
      }

      this.buildingsGroup.add(artGroup);
    }

    // Fine dashed subterranean links for paired underground belts
    const links = computeUndergroundLinks(state.doc);
    for (const link of links) {
      const opacity = this.layerOpacityFor(link.floor, state.focusFloor, state.hideAbove);
      if (opacity <= 0.01) continue;
      const y = link.floor * FLOOR_VISUAL_SPACING + 0.05;
      const pts = [new THREE.Vector3(link.x1, y, link.y1), new THREE.Vector3(link.x2, y, link.y2)];
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineDashedMaterial({
        color: COLORS.undergroundLink,
        dashSize: 0.32,
        gapSize: 0.28,
        transparent: true,
        opacity: opacity * 0.65,
      });
      const line = new THREE.Line(geo, mat);
      line.computeLineDistances();
      this.undergroundGroup.add(line);
    }
  }

  private updateRoundedGrid(state: SceneRenderState): void {
    const u = this.roundedGrid.uniforms;
    this.roundedGrid.mesh.position.y = state.focusFloor * FLOOR_VISUAL_SPACING + 0.018;

    const isStation = state.viewMode === 'station';
    u.uCellSize.value = isStation ? STATION_UNIT_M : 1.0;
    u.uCursorRadius.value = isStation ? 40.0 : 6.8;
    u.uCornerRadius.value = isStation ? 0.06 : 0.14;

    const showForTool =
      state.activeTool.kind !== 'select' || state.boxSelectRect !== null || state.beltPreview.length > 0;
    if (state.cursorWorld) {
      u.uCursorWorld.value.set(state.cursorWorld.x, state.cursorWorld.y);
      u.uCursorActive.value = 1.0;
      u.uOpacity.value = showForTool ? 0.62 : (isStation ? 0.3 : 0.42);
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
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
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

  private addFlatRectGhost(x0: number, z0: number, x1: number, z1: number, y: number, color: number, opacity = 0.85): void {
    const pts = [
      x0, y, z0, x1, y, z0,
      x1, y, z0, x1, y, z1,
      x1, y, z1, x0, y, z1,
      x0, y, z1, x0, y, z0,
    ];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.previewGroup.add(
      new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity }))
    );
  }

  private rebuildPreview(state: SceneRenderState): void {
    this.clearGroup(this.previewGroup);

    // 1. Active belt drag / Belt Planner preview (minimal hairline rails + chevrons)
    if (state.beltPreview.length > 0 && state.activeTool.kind === 'place-building') {
      const beltType = state.activeTool.buildingType;
      const baseY = state.focusFloor * FLOOR_VISUAL_SPACING + 0.07;
      for (const seg of state.beltPreview) {
        const issue = validateBuildingPlacement(
          state.doc,
          { type: beltType, x: seg.x, y: seg.y, floor: state.focusFloor, rotation: seg.rotation },
          { allowBeltReplace: true }
        );
        const col = issue ? COLORS.invalidGhost : COLORS.validGhost;
        this.addFlatRectGhost(seg.x + 0.14, seg.y + 0.14, seg.x + 0.86, seg.y + 0.86, baseY, col, 0.55);
        const chev = createDirectionalChevron(0.28, col, 0.92);
        chev.position.set(seg.x + 0.5, baseY + 0.01, seg.y + 0.5);
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
      const x0 = gx * STATION_UNIT_M + 0.12;
      const z0 = gy * STATION_UNIT_M + 0.12;
      const x1 = (gx + wu) * STATION_UNIT_M - 0.12;
      const z1 = (gy + du) * STATION_UNIT_M - 0.12;
      this.addFlatRectGhost(x0, z0, x1, z1, baseY + 0.08, col, 0.92);
      if (hu > 1) {
        this.addFlatRectGhost(x0, z0, x1, z1, baseY + FLOOR_VISUAL_SPACING + 0.08, col, 0.48);
      }
      return;
    }

    // 3. Single Building placement ghost (renders actual planar line-art silhouette + ports!)
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
      if (def.kind === 'belt') {
        this.addFlatRectGhost(bx + 0.14, by + 0.14, bx + 0.86, by + 0.86, baseY + 0.09, col, 0.85);
        const chev = createDirectionalChevron(0.32, col, 0.96);
        chev.position.set(bx + 0.5, baseY + 0.1, by + 0.5);
        chev.rotation.y = -state.activeTool.rotation * (Math.PI / 2);
        this.previewGroup.add(chev);
      } else {
        const ghostBld = {
          id: '__ghost',
          type: def.id,
          x: bx,
          y: by,
          floor: state.focusFloor,
          rotation: state.activeTool.rotation,
          undergroundMode: state.activeTool.undergroundMode,
        };
        this.previewGroup.add(buildMachineLineArt(ghostBld, def, baseY + 0.05, 0.96, false, col));
        this.addFlatRectGhost(bx + 0.04, by + 0.04, bx + w - 0.04, by + d - 0.04, baseY + 0.11, col, 0.72);
      }

      if (def.kind === 'underground') {
        const maxLen = def.maxLength ?? 8;
        const dirSign = state.activeTool.undergroundMode === 'out' ? -1 : 1;
        const dx = state.activeTool.rotation === 0 ? 1 : state.activeTool.rotation === 2 ? -1 : 0;
        const dy = state.activeTool.rotation === 1 ? 1 : state.activeTool.rotation === 3 ? -1 : 0;
        const pts = [
          new THREE.Vector3(bx + 0.5, baseY + 0.1, by + 0.5),
          new THREE.Vector3(bx + 0.5 + dx * dirSign * maxLen, baseY + 0.1, by + 0.5 + dy * dirSign * maxLen),
        ];
        const lGeo = new THREE.BufferGeometry().setFromPoints(pts);
        const guide = new THREE.Line(
          lGeo,
          new THREE.LineDashedMaterial({ color: col, dashSize: 0.35, gapSize: 0.25, transparent: true, opacity: 0.75 })
        );
        guide.computeLineDistances();
        this.previewGroup.add(guide);
      }
      return;
    }

    // 4. Blueprint Stamp Ghost (crisp planar line-art outlines)
    if (state.activeTool.kind === 'stamp-blueprint') {
      const anchorX = Math.floor(state.cursorWorld.x);
      const anchorY = Math.floor(state.cursorWorld.y);
      const anchorFloor = state.focusFloor + state.activeTool.floorOffset;
      const { modules, buildings } = computeStampCandidates(state.activeTool.blueprint, {
        x: anchorX,
        y: anchorY,
        floor: anchorFloor,
      });

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
        this.addFlatRectGhost(minX + 0.15, minY + 0.15, maxX - 0.15, maxY - 0.15, m.floor * FLOOR_VISUAL_SPACING + 0.08, col, 0.85);
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
        this.addFlatRectGhost(b.x + 0.1, b.y + 0.1, b.x + w - 0.1, b.y + d - 0.1, b.floor * FLOOR_VISUAL_SPACING + 0.09, col, 0.85);
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

    let lowFloor = state.focusFloor;
    let highFloor = state.focusFloor;
    if (state.selectionLayerMode === 'visible') {
      lowFloor = Math.min(0, state.focusFloor);
      highFloor = state.hideAbove ? state.focusFloor : Math.max(state.focusFloor + 2, 2);
    } else if (state.selectionLayerMode === 'all') {
      lowFloor = Math.min(0, state.focusFloor);
      highFloor = Math.max(state.focusFloor + 2, 3);
    }

    const y0 = lowFloor * FLOOR_VISUAL_SPACING - 0.05;
    const y1 = highFloor * FLOOR_VISUAL_SPACING + (highFloor === lowFloor ? 0.6 : 1.6);
    const h = Math.max(0.55, y1 - y0);

    const geo = new THREE.BoxGeometry(w, h, d);
    const fill = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color: COLORS.selectOutline, transparent: true, opacity: 0.05, depthWrite: false })
    );
    fill.position.set(cx, (y0 + y1) / 2, cy);
    this.boxSelectGroup.add(fill);

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: COLORS.selectOutline, transparent: true, opacity: 0.72 })
    );
    edges.position.copy(fill.position);
    this.boxSelectGroup.add(edges);
  }

  private tick = (now: number): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.tick);
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;

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
