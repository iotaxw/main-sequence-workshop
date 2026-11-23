import * as THREE from 'three';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { getBuildableDef, getItemNameZh, getModuleDef, getRecipeDef } from '../core/catalog';
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
  rotateVec2,
  STATION_UNIT_M,
  validateBuildingPlacement,
  validateModulePlacement,
  type WorldConnector,
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
import { createCrispLineSegments, setLineViewportResolution, type CrispLineOptions } from './crisp-lines';
import {
  buildBeltLineArt,
  buildIndustrialDockGantryArt,
  buildMachineLineArt,
  buildStationModuleArt,
} from './line-art';
import { createRoundedGridOverlay } from './rounded-grid-shader';
import { CAD_THEMES, type CadThemeId, type CadThemePalette } from './theme';

export interface SceneRenderState {
  doc: BlueprintDocument;
  theme: CadThemeId;
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
  simulationIssues?: Array<{ floor: number; x: number; y: number; severity: 'error' | 'warn'; code?: string }>;
}

const labelTextureCache = new Map<string, THREE.CanvasTexture>();

function getLabelTexture(
  title: string,
  subtitle: string | null,
  palette: CadThemePalette,
  maxAniso = 16
): THREE.CanvasTexture {
  const key = `${palette.id}||${title}||${subtitle ?? ''}`;
  const cached = labelTextureCache.get(key);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 384;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = palette.labelTitleHex;
  ctx.font = '500 84px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
  const yTitle = subtitle ? 132 : 192;
  ctx.fillText(title.slice(0, 10), 512, yTitle, 940);

  if (subtitle) {
    ctx.fillStyle = palette.labelSubHex;
    ctx.font = '400 66px "JetBrains Mono", Consolas, "Microsoft YaHei", monospace';
    ctx.fillText(subtitle.slice(0, 14), 512, 266, 940);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = Math.min(16, Math.max(4, maxAniso));
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  labelTextureCache.set(key, tex);
  return tex;
}

/**
 * Creates a clean 2D XZ floor surface polygon.
 * Note: Three.js Shape in XY rotated by -PI/2 around X maps (x, y) -> (x, 0, -y).
 * For 'corner-ws' (W & S connectors, NE panoramic window bevel): symmetric 45° line lx - ly = 3.0!
 */
function createFloorShapeGeometry(surf: StationFloorSurfaceDef, bevelC = 3.0): THREE.ShapeGeometry {
  const shape = new THREE.Shape();
  if (surf.shape === 'corner-ws') {
    const northCutX = THREE.MathUtils.clamp(surf.minY + bevelC, surf.minX + 1, surf.maxX - 1);
    const eastCutY = THREE.MathUtils.clamp(surf.maxX - bevelC, surf.minY + 1, surf.maxY - 1);
    shape.moveTo(surf.minX, -surf.minY);
    shape.lineTo(northCutX, -surf.minY);
    shape.lineTo(surf.maxX, -eastCutY);
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

function edgesToPositions(edgeGeo: THREE.EdgesGeometry): number[] {
  const pos = edgeGeo.attributes.position;
  const out: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    out.push(pos.getX(i), pos.getY(i), pos.getZ(i));
  }
  edgeGeo.dispose();
  return out;
}

function createDirectionalChevron(size: number, color: number, opacity: number): THREE.Object3D {
  const pts = [
    -size * 0.45, 0, -size * 0.45, size * 0.5, 0, 0,
    size * 0.5, 0, 0, -size * 0.45, 0, size * 0.45,
  ];
  return createCrispLineSegments(pts, { color, opacity, widthPx: 1.25 });
}

function createStationConnectorMark(
  span: number,
  color: number,
  opacity: number,
  mode: 'open' | 'mated' | 'ghost' | 'hint-match' | 'hint-dim'
): THREE.Object3D {
  const hs = span / 2;
  const pts: number[] = [];
  if (mode === 'mated') {
    pts.push(0, 0, -hs * 0.72, 0, 0, hs * 0.72);
    return createCrispLineSegments(pts, { color, opacity: opacity * 0.55, widthPx: 1.0, lodTier: 'detail' });
  }
  if (mode === 'hint-match') {
    // High-clarity buildable docking socket + outward snap bay guide ticks!
    pts.push(
      -0.1, 0, -hs, -0.1, 0, hs,
      0.22, 0, -hs, 0.22, 0, hs,
      -0.45, 0, -hs, 0.95, 0, -hs,
      -0.45, 0, hs, 0.95, 0, hs,
      // Outward chevron pointing into buildable adjacent cell
      0.22, 0, -0.85, 1.55, 0, 0,
      1.55, 0, 0, 0.22, 0, 0.85,
      // Delicate 4m outward snap guide tick
      2.3, 0, 0, 4.2, 0, 0
    );
    return createCrispLineSegments(pts, { color, opacity: Math.min(1, opacity), widthPx: 1.45 });
  }
  const tickIn = 0.3;
  const arrowOut = mode === 'ghost' ? 1.0 : mode === 'hint-dim' ? 0.5 : 0.48;
  pts.push(
    -0.06, 0, -hs, -0.06, 0, hs,
    -tickIn, 0, -hs, -0.06, 0, -hs,
    -tickIn, 0, hs, -0.06, 0, hs,
    -0.06, 0, -0.48, arrowOut, 0, 0,
    arrowOut, 0, 0, -0.06, 0, 0.48
  );
  return createCrispLineSegments(pts, {
    color,
    opacity,
    widthPx: mode === 'ghost' ? 1.4 : 1.08,
  });
}

function connectorKey(x: number, y: number, floor: number): string {
  return `${Math.round(x * 2)},${Math.round(y * 2)},${floor}`;
}

type BatchLayer = 'flat' | 'extruded';
type BatchSubMode = 'always' | 'station' | 'building';

interface LineBucketAccum {
  layer: BatchLayer;
  subMode: BatchSubMode;
  color: number;
  widthPx: number;
  lodTier: 'primary' | 'detail';
  dashed: boolean;
  dashSize: number;
  gapSize: number;
  alphaScale: number;
  positions: number[];
}

interface MeshBucketAccum {
  layer: BatchLayer;
  subMode: BatchSubMode;
  color: number;
  alphaScale: number;
  alwaysTransparent: boolean;
  doubleSide: boolean;
  positions: number[];
}

interface ManagedMaterialEntry {
  mat: THREE.Material;
  alphaScale: number;
  alwaysTransparent: boolean;
  isLine: boolean;
  lodTier?: 'primary' | 'detail';
}

interface LabelEntry {
  mesh: THREE.Mesh;
  roofHeight: number;
  baseOffsetY: number;
  alphaScale: number;
}

/**
 * Per-floor batched render bucket.
 * Holds merged LineSegments2 + merged MeshBasicMaterial solids so changing focusFloor (Q/E),
 * hideAbove (V), viewMode, or selection requires ZERO geometry rebuild!
 */
class FloorRenderBucket {
  readonly floor: number;
  readonly baseY: number;
  readonly root = new THREE.Group();
  readonly flatAlways = new THREE.Group();
  readonly flatStation = new THREE.Group();
  readonly flatBuilding = new THREE.Group();
  readonly extrudedAlways = new THREE.Group();
  readonly stationLabels = new THREE.Group();
  readonly buildingLabels = new THREE.Group();

  readonly materials: ManagedMaterialEntry[] = [];
  readonly labelEntries: LabelEntry[] = [];

  private lineAccums = new Map<string, LineBucketAccum>();
  private meshAccums = new Map<string, MeshBucketAccum>();
  private curFloorOpacity = 1.0;

  constructor(floor: number) {
    this.floor = floor;
    this.baseY = floor * FLOOR_VISUAL_SPACING;
    this.root.position.set(0, this.baseY, 0);
    // Keep extrudedAlways pivot cleanly above floor (+0.005) & machine base plate (+0.032) so 89° flat 2D lines never sink below floor!
    this.extrudedAlways.position.y = 0.038;
    this.root.add(
      this.flatAlways,
      this.flatStation,
      this.flatBuilding,
      this.extrudedAlways,
      this.stationLabels,
      this.buildingLabels
    );
  }

  addLineSegments(
    pts: number[],
    layer: BatchLayer,
    subMode: BatchSubMode,
    opts: {
      color: number;
      widthPx?: number;
      lodTier?: 'primary' | 'detail';
      dashed?: boolean;
      dashSize?: number;
      gapSize?: number;
      alphaScale?: number;
    }
  ): void {
    if (pts.length < 6) return;
    const widthPx = Math.round((opts.widthPx ?? 1.2) * 20) / 20;
    const lodTier = opts.lodTier ?? 'primary';
    const dashed = Boolean(opts.dashed);
    const dashSize = opts.dashSize ?? 0.35;
    const gapSize = opts.gapSize ?? 0.28;
    const alphaScale = Math.round((opts.alphaScale ?? 1.0) * 100) / 100;
    const key = `${layer}|${subMode}|${opts.color}|${widthPx}|${lodTier}|${dashed ? `${dashSize}:${gapSize}` : 'S'}|${alphaScale}`;
    let acc = this.lineAccums.get(key);
    if (!acc) {
      acc = {
        layer,
        subMode,
        color: opts.color,
        widthPx,
        lodTier,
        dashed,
        dashSize,
        gapSize,
        alphaScale,
        positions: [],
      };
      this.lineAccums.set(key, acc);
    }
    const out = acc.positions;
    for (let i = 0; i < pts.length; i++) {
      out.push(pts[i]);
    }
  }

  addGeometryTriangles(
    geo: THREE.BufferGeometry,
    matrix: THREE.Matrix4,
    layer: BatchLayer,
    subMode: BatchSubMode,
    color: number,
    alphaScale = 0.98,
    alwaysTransparent = false,
    doubleSide = false
  ): void {
    const posAttr = geo.attributes.position;
    if (!posAttr || posAttr.count < 3) return;
    const aScale = Math.round(alphaScale * 100) / 100;
    const key = `${layer}|${subMode}|${color}|${aScale}|${alwaysTransparent ? 1 : 0}|${doubleSide ? 1 : 0}`;
    let acc = this.meshAccums.get(key);
    if (!acc) {
      acc = {
        layer,
        subMode,
        color,
        alphaScale: aScale,
        alwaysTransparent,
        doubleSide,
        positions: [],
      };
      this.meshAccums.set(key, acc);
    }
    const out = acc.positions;
    const v = new THREE.Vector3();
    const index = geo.index;
    if (index) {
      for (let i = 0; i < index.count; i++) {
        const idx = index.getX(i);
        v.fromBufferAttribute(posAttr, idx).applyMatrix4(matrix);
        out.push(v.x, v.y, v.z);
      }
    } else {
      for (let i = 0; i < posAttr.count; i++) {
        v.fromBufferAttribute(posAttr, i).applyMatrix4(matrix);
        out.push(v.x, v.y, v.z);
      }
    }
  }

  /**
   * Flattens an entire temporary Object3D subtree (produced by line-art builders) into this floor's merged buffers
   * and disposes the temporary geometries/materials immediately!
   */
  ingestObject(
    obj: THREE.Object3D,
    extrudeSubtree: THREE.Object3D | null,
    subMode: BatchSubMode = 'always'
  ): void {
    obj.updateMatrixWorld(true);
    const invFlatOffset = new THREE.Matrix4().makeTranslation(0, -this.baseY, 0);
    const invExtrudeOffset = new THREE.Matrix4().makeTranslation(0, -(this.baseY + 0.038), 0);
    const relMat = new THREE.Matrix4();
    const v = new THREE.Vector3();

    const isInsideExtrude = (node: THREE.Object3D): boolean => {
      if (!extrudeSubtree) return false;
      let cur: THREE.Object3D | null = node;
      while (cur) {
        if (cur === extrudeSubtree) return true;
        cur = cur.parent;
      }
      return false;
    };

    obj.traverse((node) => {
      const rawPts = node.userData?.rawPositions as number[] | undefined;
      if (rawPts && rawPts.length >= 6) {
        const opts = (node.userData.lineOpts ?? {}) as CrispLineOptions;
        const layer: BatchLayer = isInsideExtrude(node) ? 'extruded' : 'flat';
        relMat.multiplyMatrices(layer === 'extruded' ? invExtrudeOffset : invFlatOffset, node.matrixWorld);
        const transformed: number[] = new Array(rawPts.length);
        for (let i = 0; i < rawPts.length; i += 3) {
          v.set(rawPts[i], rawPts[i + 1], rawPts[i + 2]).applyMatrix4(relMat);
          transformed[i] = v.x;
          transformed[i + 1] = v.y;
          transformed[i + 2] = v.z;
        }
        this.addLineSegments(transformed, layer, subMode, {
          color: opts.color ?? 0xcbd8e6,
          widthPx: opts.widthPx,
          lodTier: opts.lodTier,
          dashed: opts.dashed,
          dashSize: opts.dashSize,
          gapSize: opts.gapSize,
          alphaScale: opts.opacity ?? 1.0,
        });
        return;
      }

      if ((node as THREE.Mesh).isMesh && !(node as LineSegments2).isLineSegments2) {
        const mesh = node as THREE.Mesh;
        const mat = mesh.material as THREE.MeshBasicMaterial | undefined;
        if (!mat || mat.map) return; // Labels are added separately
        const layer: BatchLayer = isInsideExtrude(node) ? 'extruded' : 'flat';
        relMat.multiplyMatrices(layer === 'extruded' ? invExtrudeOffset : invFlatOffset, node.matrixWorld);
        this.addGeometryTriangles(
          mesh.geometry,
          relMat,
          layer,
          subMode,
          mat.color.getHex(),
          mat.opacity,
          mat.opacity < 0.94,
          mat.side === THREE.DoubleSide
        );
      }
    });

    // Dispose temporary geometries & materials immediately
    obj.traverse((node) => {
      if ((node as THREE.Mesh).geometry) {
        (node as THREE.Mesh).geometry.dispose();
      }
      const m = (node as THREE.Mesh).material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else if (m) m.dispose();
    });
  }

  addLabel(
    kind: 'station' | 'building',
    tex: THREE.CanvasTexture,
    width: number,
    cx: number,
    cz: number,
    baseOffsetY: number,
    roofHeight: number,
    alphaScale: number
  ): void {
    const geo = new THREE.PlaneGeometry(width, width * 0.375);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: alphaScale,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(cx, baseOffsetY + roofHeight, cz);
    if (kind === 'station') this.stationLabels.add(mesh);
    else this.buildingLabels.add(mesh);
    this.labelEntries.push({ mesh, roofHeight, baseOffsetY, alphaScale });
  }

  private getTargetGroup(layer: BatchLayer, subMode: BatchSubMode): THREE.Group {
    if (layer === 'extruded') return this.extrudedAlways;
    if (subMode === 'station') return this.flatStation;
    if (subMode === 'building') return this.flatBuilding;
    return this.flatAlways;
  }

  finalize(): void {
    // 1. Emit merged matte occlusion meshes (all with polygonOffset so lines never depth-fight!)
    for (const acc of this.meshAccums.values()) {
      if (acc.positions.length < 9) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(acc.positions, 3));
      const mat = new THREE.MeshBasicMaterial({
        color: acc.color,
        transparent: acc.alwaysTransparent,
        opacity: acc.alphaScale,
        side: acc.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
        polygonOffset: true,
        polygonOffsetFactor: 2,
        polygonOffsetUnits: 4,
        depthWrite: !acc.alwaysTransparent,
      });
      const mesh = new THREE.Mesh(geo, mat);
      this.getTargetGroup(acc.layer, acc.subMode).add(mesh);
      this.materials.push({
        mat,
        alphaScale: acc.alphaScale,
        alwaysTransparent: acc.alwaysTransparent,
        isLine: false,
      });
    }
    this.meshAccums.clear();

    // 2. Emit merged crisp LineSegments2 batches
    for (const acc of this.lineAccums.values()) {
      if (acc.positions.length < 6) continue;
      const segs = createCrispLineSegments(acc.positions, {
        color: acc.color,
        opacity: acc.alphaScale,
        widthPx: acc.widthPx,
        lodTier: acc.lodTier,
        dashed: acc.dashed,
        dashSize: acc.dashSize,
        gapSize: acc.gapSize,
      });
      this.getTargetGroup(acc.layer, acc.subMode).add(segs);
      this.materials.push({
        mat: segs.material,
        alphaScale: acc.alphaScale,
        alwaysTransparent: true,
        isLine: true,
        lodTier: acc.lodTier,
      });
    }
    this.lineAccums.clear();
  }

  applyVisibility(opacity: number, viewMode: ViewMode, detailLod: number): void {
    this.curFloorOpacity = opacity;
    if (opacity <= 0.01) {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;
    this.flatStation.visible = viewMode === 'station';
    this.flatBuilding.visible = viewMode === 'building';
    this.stationLabels.visible = viewMode === 'station' && opacity >= 0.45;
    this.buildingLabels.visible = viewMode === 'building' && opacity >= 0.45;

    for (const entry of this.materials) {
      if (entry.isLine) {
        const lineMat = entry.mat as LineMaterial;
        const lodMult = entry.lodTier === 'detail' ? detailLod : 1.0;
        lineMat.opacity = opacity * entry.alphaScale * lodMult;
      } else {
        const meshMat = entry.mat as THREE.MeshBasicMaterial;
        const shouldBeTrans = entry.alwaysTransparent || opacity < 0.99;
        if (meshMat.transparent !== shouldBeTrans) {
          meshMat.transparent = shouldBeTrans;
          meshMat.depthWrite = !shouldBeTrans;
          meshMat.needsUpdate = true;
        }
        meshMat.opacity = opacity * entry.alphaScale;
      }
    }

    for (const lbl of this.labelEntries) {
      (lbl.mesh.material as THREE.MeshBasicMaterial).opacity = opacity * lbl.alphaScale;
    }
  }

  applyDetailLodOnly(detailLod: number): void {
    if (!this.root.visible) return;
    for (const entry of this.materials) {
      if (entry.isLine && entry.lodTier === 'detail') {
        (entry.mat as LineMaterial).opacity = this.curFloorOpacity * entry.alphaScale * detailLod;
      }
    }
  }

  applyExtrusion(yScale: number): void {
    this.extrudedAlways.scale.y = yScale;
    for (const lbl of this.labelEntries) {
      lbl.mesh.position.y = lbl.baseOffsetY + lbl.roofHeight * yScale;
    }
  }

  dispose(): void {
    this.root.traverse((obj) => {
      if ((obj as THREE.Mesh).geometry) {
        (obj as THREE.Mesh).geometry.dispose();
      }
      const mat = (obj as THREE.Mesh).material;
      if (Array.isArray(mat)) {
        mat.forEach((m) => {
          // Do not dispose shared cached label CanvasTexture!
          m.dispose();
        });
      } else if (mat) {
        mat.dispose();
      }
    });
  }
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
  private worldGroup = new THREE.Group();
  private selectionGroup = new THREE.Group();
  private dockHintsGroup = new THREE.Group();
  private previewGroup = new THREE.Group();
  private boxSelectGroup = new THREE.Group();
  private roundedGrid: ReturnType<typeof createRoundedGridOverlay>;

  private floorBuckets = new Map<number, FloorRenderBucket>();
  private cachedAllConnectors: WorldConnector[] = [];
  private cachedConnCounts = new Map<string, number>();

  private keysDown = new Set<string>();
  private lastState: SceneRenderState | null = null;
  private activePalette: CadThemePalette = CAD_THEMES['platinum-gold'];
  private maxAniso = 16;

  private ghostExtrudeTargets: THREE.Group[] = [];
  private lastDetailLod = 1.0;

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
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(this.activePalette.bg, 1);
    const initW = container.clientWidth || 800;
    const initH = container.clientHeight || 600;
    this.renderer.setSize(initW, initH);
    setLineViewportResolution(initW, initH);
    this.maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(this.activePalette.bg, 0.00018);

    const hemi = new THREE.HemisphereLight(0xb8cade, this.activePalette.bg, 0.9);
    this.scene.add(hemi);

    this.rig = new CadCameraRig(initW / Math.max(1, initH), callbacks);

    this.roundedGrid = createRoundedGridOverlay();
    this.scene.add(this.referenceGroup);
    this.scene.add(this.worldGroup);
    this.scene.add(this.selectionGroup);
    this.scene.add(this.dockHintsGroup);
    this.scene.add(this.roundedGrid.mesh);
    this.scene.add(this.previewGroup);
    this.scene.add(this.boxSelectGroup);

    this.buildMinimalReferenceAxes(this.activePalette);
    this.lastTime = performance.now();
    this.tick(this.lastTime);
  }

  private buildMinimalReferenceAxes(palette: CadThemePalette): void {
    this.clearGroup(this.referenceGroup);
    const pts: number[] = [];
    const extent = 16 * 30; // ±480m macro drafting axes
    pts.push(-extent, 0, 0, extent, 0, 0);
    pts.push(0, 0, -extent, 0, 0, extent);

    for (let gx = -10; gx <= 10; gx++) {
      for (let gz = -10; gz <= 10; gz++) {
        if (gx === 0 && gz === 0) continue;
        const x = gx * STATION_UNIT_M;
        const z = gz * STATION_UNIT_M;
        pts.push(x - 0.55, 0, z, x + 0.55, 0, z);
        pts.push(x, 0, z - 0.55, x, 0, z + 0.55);
      }
    }
    this.referenceGroup.add(
      createCrispLineSegments(pts, {
        color: palette.refAxis,
        opacity: 1.0,
        widthPx: 1.0,
      })
    );
  }

  private applyThemeToScene(palette: CadThemePalette): void {
    this.activePalette = palette;
    this.renderer.setClearColor(palette.bg, 1);
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.color.setHex(palette.bg);
    }
    this.roundedGrid.uniforms.uLineColor.value.set(palette.gridLineHex);
    this.roundedGrid.uniforms.uFillColor.value.set(palette.gridFillHex);
    this.buildMinimalReferenceAxes(palette);
  }

  resize(): void {
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 600;
    this.renderer.setSize(w, h);
    setLineViewportResolution(w, h);
    this.rig.setAspect(w / Math.max(1, h));
  }

  setKeyDown(code: string, down: boolean): void {
    if (down) this.keysDown.add(code);
    else this.keysDown.delete(code);
  }

  clearKeys(): void {
    this.keysDown.clear();
  }

  private getOrCreateFloorBucket(floor: number): FloorRenderBucket {
    let bucket = this.floorBuckets.get(floor);
    if (!bucket) {
      bucket = new FloorRenderBucket(floor);
      this.floorBuckets.set(floor, bucket);
      this.worldGroup.add(bucket.root);
    }
    return bucket;
  }

  private clearFloorBuckets(): void {
    for (const bucket of this.floorBuckets.values()) {
      this.worldGroup.remove(bucket.root);
      bucket.dispose();
    }
    this.floorBuckets.clear();
  }

  syncState(state: SceneRenderState): void {
    const prev = this.lastState;
    this.lastState = state;

    const palette = CAD_THEMES[state.theme];
    const themeChanged = !prev || prev.theme !== state.theme;
    if (themeChanged) {
      this.applyThemeToScene(palette);
    }

    this.rig.setFocusFloor(state.focusFloor);
    this.referenceGroup.position.y = state.focusFloor * FLOOR_VISUAL_SPACING - 0.06;

    // ONLY rebuild heavy world geometry when document or theme changes!
    // Q/E (focusFloor), V (hideAbove), viewMode, selection NEVER rebuild world geometry!
    const docOrThemeChanged = themeChanged || !prev || prev.doc !== state.doc;
    if (docOrThemeChanged) {
      this.rebuildWorldBatches(state.doc, palette);
    }

    const visibilityChanged =
      docOrThemeChanged ||
      prev.focusFloor !== state.focusFloor ||
      prev.hideAbove !== state.hideAbove ||
      prev.viewMode !== state.viewMode;

    if (visibilityChanged) {
      this.applyFloorVisibilities(state);
    }

    const selectionChanged =
      visibilityChanged ||
      prev.selection !== state.selection ||
      prev.simulationIssues !== state.simulationIssues;
    if (selectionChanged) {
      this.rebuildSelectionOverlay(state, palette);
    }

    const dockHintsChanged =
      docOrThemeChanged ||
      prev.focusFloor !== state.focusFloor ||
      prev.hideAbove !== state.hideAbove ||
      prev.viewMode !== state.viewMode ||
      prev.activeTool !== state.activeTool ||
      prev.cursorWorld !== state.cursorWorld;
    if (dockHintsChanged) {
      this.rebuildDockHints(state, palette);
    }

    this.updateRoundedGrid(state);
    this.rebuildPreview(state, palette);
    this.rebuildBoxSelect(state, palette);
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
    return Math.max(0.22, 0.48 - dist * 0.12);
  }

  private applyFloorVisibilities(state: SceneRenderState): void {
    const lod = this.computeDistanceLod();
    this.lastDetailLod = lod;
    const yScale = this.getCurrentExtrusionScale();
    for (const bucket of this.floorBuckets.values()) {
      const op = this.layerOpacityFor(bucket.floor, state.focusFloor, state.hideAbove);
      bucket.applyVisibility(op, state.viewMode, lod);
      bucket.applyExtrusion(yScale);
    }
  }

  /**
   * Builds ALL station modules, interior buildings, underground links, and connectors into
   * compact per-floor batched GPU buffers (called ONLY when `doc` or `theme` changes!).
   */
  private rebuildWorldBatches(doc: BlueprintDocument, palette: CadThemePalette): void {
    this.clearFloorBuckets();

    // 1. Pre-compute all connectors & mate counts across the station
    const allConns: WorldConnector[] = [];
    const connCounts = new Map<string, number>();
    for (const mod of doc.modules) {
      const def = getModuleDef(mod.type);
      if (!def) continue;
      for (const c of getModuleWorldConnectors(mod, def)) {
        allConns.push(c);
        if (!c.type.startsWith('Vertical')) {
          const key = connectorKey(c.x, c.y, c.floor);
          connCounts.set(key, (connCounts.get(key) ?? 0) + 1);
        }
      }
    }
    this.cachedAllConnectors = allConns;
    this.cachedConnCounts = connCounts;
    const drawnMated = new Set<string>();

    // 2. Batch all station modules
    for (const mod of doc.modules) {
      const def = getModuleDef(mod.type);
      if (!def) continue;
      this.ingestStationModule(mod, def, palette, connCounts, drawnMated);
    }

    // 3. Batch all interior buildings & belts
    for (const b of doc.buildings) {
      const def = getBuildableDef(b.type);
      if (!def) continue;
      const bucket = this.getOrCreateFloorBucket(b.floor);
      const baseY = b.floor * FLOOR_VISUAL_SPACING;

      if (def.kind === 'belt') {
        const beltGroup = buildBeltLineArt(doc, b, def, baseY, 1.0, false, palette);
        bucket.ingestObject(beltGroup, null, 'always');
        continue;
      }

      const { root, extrudeGroup, roofHeight } = buildMachineLineArt(b, def, baseY, 1.0, false, palette);
      bucket.ingestObject(root, extrudeGroup, 'always');

      const recipe = b.recipeId ? getRecipeDef(b.recipeId) : null;
      const firstFilter = b.filterItems && b.filterItems.length > 0 ? getItemNameZh(b.filterItems[0]) : null;
      const caption = b.label || recipe?.nameZh || firstFilter || null;
      const [w, d] = getBuildingSizeCells(def, b.rotation);
      if (caption && (Math.min(w, d) >= 2 || def.kind === 'sign')) {
        const [cx, cz] = getBuildingCenterM(b, def);
        const tex = getLabelTexture(caption, null, palette, this.maxAniso);
        const labelW = def.kind === 'sign' ? 1.4 : Math.min(w - 0.35, 3.8);
        bucket.addLabel('building', tex, labelW, cx, cz, 0.09, roofHeight, 0.94);
      }
    }

    // 4. Batch underground belt dashed links
    for (const link of computeUndergroundLinks(doc)) {
      const bucket = this.getOrCreateFloorBucket(link.floor);
      bucket.addLineSegments([link.x1, 0.05, link.y1, link.x2, 0.05, link.y2], 'flat', 'always', {
        color: palette.undergroundLink,
        alphaScale: 0.8,
        widthPx: 1.1,
        dashed: true,
        dashSize: 0.32,
        gapSize: 0.28,
      });
    }

    // 5. Finalize merged GPU buffers per floor
    for (const bucket of this.floorBuckets.values()) {
      bucket.finalize();
    }
  }

  private ingestStationModule(
    mod: PlacedModule,
    def: StationModuleDef,
    palette: CadThemePalette,
    connCounts: Map<string, number>,
    drawnMated: Set<string>
  ): void {
    const bucket = this.getOrCreateFloorBucket(mod.floor);
    const [cx, cy] = getModuleCenterM(mod, def);
    const [wu, du, hu] = getModuleSizeUnits(def, mod.rotation);
    const wM = wu * STATION_UNIT_M;
    const dM = du * STATION_UNIT_M;
    const baseY = mod.floor * FLOOR_VISUAL_SPACING;
    const rotY = -mod.rotation * (Math.PI / 2);

    let labelRoofHeight = 0.02;

    if (!def.hasFactoryFloor) {
      const art = buildStationModuleArt(mod, def, baseY, 1.0, false, palette);
      labelRoofHeight = art.roofHeight;
      bucket.ingestObject(art.root, art.extrudeGroup, 'always');
    } else {
      const tempGroup = new THREE.Group();
      const slabMat = new THREE.MeshBasicMaterial({
        color: palette.slabFill,
        opacity: 0.98,
        side: THREE.DoubleSide,
      });

      if (def.id === 'BPO_StationCorridor_01' || def.id === 'BPO_StationCorner_01') {
        const f0 = def.floors[0];
        const padSurf: StationFloorSurfaceDef =
          def.id === 'BPO_StationCorridor_01'
            ? { ...f0, minX: -8, maxX: 8, minY: -3.7, maxY: 3.7 }
            : { ...f0, minX: -7.9, maxX: 7.9, minY: -7.9, maxY: 7.9 };
        const slabShapeGeo = createFloorShapeGeometry(padSurf, 3.2);
        const slabMesh = new THREE.Mesh(slabShapeGeo, slabMat);
        slabMesh.position.set(cx, baseY - 0.02, cy);
        slabMesh.rotation.y = rotY;
        tempGroup.add(slabMesh);

        const rimPts = edgesToPositions(new THREE.EdgesGeometry(slabShapeGeo));
        const rimLine = createCrispLineSegments(rimPts, {
          color: palette.slabEdge,
          opacity: 1.0,
          widthPx: 1.12,
        });
        rimLine.position.set(cx, baseY - 0.012, cy);
        rimLine.rotation.y = rotY;
        tempGroup.add(rimLine);

        // Panoramic corner glass window double-mullion accent along the 45° NE bevel
        if (def.id === 'BPO_StationCorner_01') {
          const glassPts = [
            -4.7, 0, -7.9, 7.9, 0, 4.7,
            -4.2, 0, -7.4, 7.4, 0, 4.2,
          ];
          const glassLine = createCrispLineSegments(glassPts, {
            color: palette.researchTint,
            opacity: 0.85,
            widthPx: 1.2,
            lodTier: 'primary',
          });
          glassLine.position.set(cx, baseY + 0.03, cy);
          glassLine.rotation.y = rotY;
          tempGroup.add(glassLine);
        }
      } else if (def.id === 'BPO_Dock_2') {
        // Industrial Dock 3x2: west 1x2 indoor factory bay slab (X in [-23.9, -8.0]) + east 2x2 sculpted gantry berth!
        const bayHolder = new THREE.Group();
        bayHolder.position.set(cx, baseY, cy);
        bayHolder.rotation.y = rotY;

        const bayGeo = new THREE.BoxGeometry(15.9, 0.28, 31.8);
        const bayMesh = new THREE.Mesh(bayGeo, slabMat);
        bayMesh.position.set(-15.95, -0.16, 0);
        bayHolder.add(bayMesh);

        const bayRimPts = [
          -23.9, -0.015, -15.9, -8.0, -0.015, -15.9,
          -8.0, -0.015, -15.9, -8.0, -0.015, 15.9,
          -8.0, -0.015, 15.9, -23.9, -0.015, 15.9,
          -23.9, -0.015, 15.9, -23.9, -0.015, -15.9,
        ];
        bayHolder.add(createCrispLineSegments(bayRimPts, { color: palette.slabEdge, opacity: 1.0, widthPx: 1.15 }));
        tempGroup.add(bayHolder);

        // Sculpted 3D/2D east open freighter gantry arms & berth guide
        const gantryArt = buildIndustrialDockGantryArt(mod, def, baseY, 1.0, false, palette);
        bucket.ingestObject(gantryArt.root, gantryArt.extrudeGroup, 'always');
      } else {
        const slabThickness = 0.28;
        const slabW = wM - 0.1;
        const slabD = dM - 0.1;
        const slabGeo = new THREE.BoxGeometry(slabW, slabThickness, slabD);
        const slab = new THREE.Mesh(slabGeo, slabMat);
        slab.position.set(cx, baseY - slabThickness / 2 - 0.02, cy);
        tempGroup.add(slab);

        const shw = slabW / 2;
        const shd = slabD / 2;
        const topRimY = baseY - 0.015;
        const slabTopPts = [
          cx - shw, topRimY, cy - shd, cx + shw, topRimY, cy - shd,
          cx + shw, topRimY, cy - shd, cx + shw, topRimY, cy + shd,
          cx + shw, topRimY, cy + shd, cx - shw, topRimY, cy + shd,
          cx - shw, topRimY, cy + shd, cx - shw, topRimY, cy - shd,
        ];
        tempGroup.add(createCrispLineSegments(slabTopPts, { color: palette.slabEdge, opacity: 1.0, widthPx: 1.12 }));
      }
      bucket.ingestObject(tempGroup, null, 'always');

      // Floor surface(s) placed into their respective floor bucket!
      for (const surf of def.floors) {
        const surfFloor = mod.floor + surf.floorOffset;
        const surfBucket = this.getOrCreateFloorBucket(surfFloor);
        const surfY = surfFloor * FLOOR_VISUAL_SPACING;

        const floorGeo = createFloorShapeGeometry(surf, 3.0);
        const floorMat = new THREE.MeshBasicMaterial({
          color: surf.floorOffset > 0 ? palette.floorBalconyFill : palette.floorFill,
          opacity: surf.floorOffset > 0 ? 0.92 : 0.98,
          side: THREE.DoubleSide,
        });
        const floorMesh = new THREE.Mesh(floorGeo, floorMat);
        floorMesh.position.set(cx, surfY + 0.005, cy);
        floorMesh.rotation.y = rotY;

        const floorWrap = new THREE.Group();
        floorWrap.add(floorMesh);
        surfBucket.ingestObject(floorWrap, null, 'always');

        // Floor border: always shown on L+1 balconies & rings; shown only in Building View on standard floors!
        const borderPts = edgesToPositions(new THREE.EdgesGeometry(floorGeo));
        const borderLine = createCrispLineSegments(borderPts, {
          color: surf.floorOffset > 0 ? palette.floorBalconyEdge : palette.floorEdge,
          opacity: 1.0,
          widthPx: 0.95,
          lodTier: surf.floorOffset > 0 ? 'primary' : 'detail',
        });
        borderLine.position.set(cx, surfY + 0.009, cy);
        borderLine.rotation.y = rotY;
        const borderWrap = new THREE.Group();
        borderWrap.add(borderLine);
        const borderSubMode: BatchSubMode =
          surf.floorOffset > 0 || surf.shape === 'ring' ? 'always' : 'building';
        surfBucket.ingestObject(borderWrap, null, borderSubMode);
      }

      // Double-height corner wireframe guides
      if (hu > 1) {
        const topRelY = (hu - 1) * FLOOR_VISUAL_SPACING;
        const hw = wM / 2 - 0.25;
        const hd = dM / 2 - 0.25;
        const pts = [
          cx - hw, 0, cy - hd, cx - hw, topRelY, cy - hd,
          cx + hw, 0, cy - hd, cx + hw, topRelY, cy - hd,
          cx + hw, 0, cy + hd, cx + hw, topRelY, cy + hd,
          cx - hw, 0, cy + hd, cx - hw, topRelY, cy + hd,
          cx - hw, topRelY, cy - hd, cx + hw, topRelY, cy - hd,
          cx + hw, topRelY, cy - hd, cx + hw, topRelY, cy + hd,
          cx + hw, topRelY, cy + hd, cx - hw, topRelY, cy + hd,
          cx - hw, topRelY, cy + hd, cx - hw, topRelY, cy - hd,
        ];
        bucket.addLineSegments(pts, 'flat', 'always', {
          color: palette.heightFrame,
          alphaScale: 0.55,
          widthPx: 1.0,
        });
      }
    }

    // Connectors placed into their own connector floor bucket!
    for (const c of getModuleWorldConnectors(mod, def)) {
      const cBucket = this.getOrCreateFloorBucket(c.floor);
      const cyWorld = c.floor * FLOOR_VISUAL_SPACING + 0.05;
      if (c.type.startsWith('Vertical')) {
        const r = c.type === 'Vertical2x2' ? 3.2 : 1.7;
        const pts = [
          c.x, 0.05, c.y - r, c.x + r, 0.05, c.y,
          c.x + r, 0.05, c.y, c.x, 0.05, c.y + r,
          c.x, 0.05, c.y + r, c.x - r, 0.05, c.y,
          c.x - r, 0.05, c.y, c.x, 0.05, c.y - r,
        ];
        cBucket.addLineSegments(pts, 'flat', 'always', {
          color: palette.connVertical,
          alphaScale: 1.0,
          widthPx: 1.12,
        });
      } else {
        const key = connectorKey(c.x, c.y, c.floor);
        const isMated = (connCounts.get(key) ?? 0) >= 2;
        if (isMated) {
          if (drawnMated.has(key)) continue;
          drawnMated.add(key);
        }
        const isXL = c.type === 'XLarge';
        const span = isXL ? 18 : 5.2;
        const col = isXL ? palette.connXLarge : palette.connLarge;
        const mark = createStationConnectorMark(span, col, 1.0, isMated ? 'mated' : 'open');
        mark.position.set(c.x, cyWorld, c.y);
        mark.rotation.y = -c.rotation * (Math.PI / 2);
        const wrap = new THREE.Group();
        wrap.add(mark);
        cBucket.ingestObject(wrap, null, 'station');
      }
    }

    // Station Overview caption label
    const shortName = getShortLabel(def.id, def.nameZh);
    const tex = getLabelTexture(shortName, mod.label || null, palette, this.maxAniso);
    const labelW = Math.min(wM * 0.58, 12);
    // For BPO_Dock_2, center label neatly over the west indoor bay (-15.5m local X)
    let labelX = cx;
    let labelZ = cy;
    if (def.id === 'BPO_Dock_2') {
      const [rx, ry] = rotateVec2(-15.5, 0, mod.rotation);
      labelX = cx + rx;
      labelZ = cy + ry;
    }
    bucket.addLabel('station', tex, labelW, labelX, labelZ, 0.06, labelRoofHeight, 0.88);
  }

  /**
   * Ultra-fast selection highlight overlay (never rebuilds world batches!).
   */
  private rebuildSelectionOverlay(state: SceneRenderState, palette: CadThemePalette): void {
    this.clearGroup(this.selectionGroup);
    const hasSelection = state.selection.moduleIds.length > 0 || state.selection.buildingIds.length > 0;
    const simIssues = state.simulationIssues ?? [];
    if (!hasSelection && simIssues.length === 0) return;

    const selectedMods = new Set(state.selection.moduleIds);
    const selectedBlds = new Set(state.selection.buildingIds);
    const pts: number[] = [];

    for (const mod of state.doc.modules) {
      if (!selectedMods.has(mod.id)) continue;
      const def = getModuleDef(mod.type);
      if (!def) continue;
      const op = this.layerOpacityFor(mod.floor, state.focusFloor, state.hideAbove);
      if (op <= 0.01) continue;
      const [x0, z0, x1, z1] = getModuleBoundsM(mod, def);
      const y = mod.floor * FLOOR_VISUAL_SPACING + 0.11;
      const pad = 0.08;
      pts.push(
        x0 + pad, y, z0 + pad, x1 - pad, y, z0 + pad,
        x1 - pad, y, z0 + pad, x1 - pad, y, z1 - pad,
        x1 - pad, y, z1 - pad, x0 + pad, y, z1 - pad,
        x0 + pad, y, z1 - pad, x0 + pad, y, z0 + pad
      );
      // Corner bracket ticks for crisp CAD selection emphasis
      const cLen = 1.6;
      pts.push(
        x0 - 0.15, y, z0 - 0.15, x0 + cLen, y, z0 - 0.15,
        x0 - 0.15, y, z0 - 0.15, x0 - 0.15, y, z0 + cLen,
        x1 + 0.15, y, z0 - 0.15, x1 - cLen, y, z0 - 0.15,
        x1 + 0.15, y, z0 - 0.15, x1 + 0.15, y, z0 + cLen,
        x1 + 0.15, y, z1 + 0.15, x1 - cLen, y, z1 + 0.15,
        x1 + 0.15, y, z1 + 0.15, x1 + 0.15, y, z1 - cLen,
        x0 - 0.15, y, z1 + 0.15, x0 + cLen, y, z1 + 0.15,
        x0 - 0.15, y, z1 + 0.15, x0 - 0.15, y, z1 - cLen
      );
    }

    for (const b of state.doc.buildings) {
      if (!selectedBlds.has(b.id)) continue;
      const def = getBuildableDef(b.type);
      if (!def) continue;
      const op = this.layerOpacityFor(b.floor, state.focusFloor, state.hideAbove);
      if (op <= 0.01) continue;
      const [w, d] = getBuildingSizeCells(def, b.rotation);
      const y = b.floor * FLOOR_VISUAL_SPACING + 0.12;
      const x0 = b.x + 0.03;
      const z0 = b.y + 0.03;
      const x1 = b.x + w - 0.03;
      const z1 = b.y + d - 0.03;
      pts.push(
        x0, y, z0, x1, y, z0,
        x1, y, z0, x1, y, z1,
        x1, y, z1, x0, y, z1,
        x0, y, z1, x0, y, z0
      );
    }

    if (pts.length >= 6) {
      this.selectionGroup.add(
        createCrispLineSegments(pts, {
          color: palette.selectOutline,
          opacity: 1.0,
          widthPx: 1.75,
        })
      );
    }

    if (simIssues.length > 0) {
      const errPts: number[] = [];
      const warnPts: number[] = [];
      const inputWarnPts: number[] = [];
      for (const issue of simIssues) {
        const op = this.layerOpacityFor(issue.floor, state.focusFloor, state.hideAbove);
        if (op <= 0.01) continue;
        const y = issue.floor * FLOOR_VISUAL_SPACING + 0.16;
        const x0 = issue.x + 0.08;
        const z0 = issue.y + 0.08;
        const x1 = issue.x + 0.92;
        const z1 = issue.y + 0.92;
        if (issue.severity === 'error') {
          errPts.push(
            x0, y, z0, x1, y, z0,
            x1, y, z0, x1, y, z1,
            x1, y, z1, x0, y, z1,
            x0, y, z1, x0, y, z0,
            x0 + 0.12, y, z0 + 0.12, x1 - 0.12, y, z1 - 0.12,
            x1 - 0.12, y, z0 + 0.12, x0 + 0.12, y, z1 - 0.12
          );
        } else if (issue.code === 'external-input-needed') {
          // Crisp amber-yellow outer frame + inner diamond pip marking every raw-material input point!
          const cx = issue.x + 0.5;
          const cz = issue.y + 0.5;
          const r = 0.24;
          inputWarnPts.push(
            x0, y, z0, x1, y, z0,
            x1, y, z0, x1, y, z1,
            x1, y, z1, x0, y, z1,
            x0, y, z1, x0, y, z0,
            cx, y, cz - r, cx + r, y, cz,
            cx + r, y, cz, cx, y, cz + r,
            cx, y, cz + r, cx - r, y, cz,
            cx - r, y, cz, cx, y, cz - r
          );
        } else {
          warnPts.push(
            x0, y, z0, x1, y, z0,
            x1, y, z0, x1, y, z1,
            x1, y, z1, x0, y, z1,
            x0, y, z1, x0, y, z0,
            x0 + 0.16, y, z0 + 0.16, x1 - 0.16, y, z1 - 0.16
          );
        }
      }
      if (errPts.length >= 6) {
        this.selectionGroup.add(
          createCrispLineSegments(errPts, {
            color: palette.simErrorColor,
            opacity: 0.96,
            widthPx: 2.1,
          })
        );
      }
      if (inputWarnPts.length >= 6) {
        this.selectionGroup.add(
          createCrispLineSegments(inputWarnPts, {
            color: palette.simWarnColor,
            opacity: 0.96,
            widthPx: 1.8,
          })
        );
      }
      if (warnPts.length >= 6) {
        this.selectionGroup.add(
          createCrispLineSegments(warnPts, {
            color: palette.simWarnColor,
            opacity: 0.92,
            widthPx: 1.7,
          })
        );
      }
    }
  }

  /**
   * Live buildability & docking connector cues when holding a station module (or station stamp blueprint).
   * Highlights ALL open compatible attachment faces on existing modules + illuminates exact mated-lock seals
   * whenever the hovered ghost docks flush against an existing open connector!
   */
  private rebuildDockHints(state: SceneRenderState, palette: CadThemePalette): void {
    this.clearGroup(this.dockHintsGroup);

    const tool = state.activeTool;
    const isPlacingMod = tool.kind === 'place-module';
    const isStampingMods =
      tool.kind === 'stamp-blueprint' && tool.blueprint.modules.length > 0;
    if (!isPlacingMod && !isStampingMods) return;

    // Determine connector types carried by the held module(s)
    const heldTypes = new Set<string>();
    const ghostConns: WorldConnector[] = [];

    if (tool.kind === 'place-module') {
      const def = getModuleDef(tool.moduleType);
      if (!def) return;
      for (const c of def.connectors) heldTypes.add(c.type);
      if (state.cursorWorld) {
        const gx = Math.floor(state.cursorWorld.x / STATION_UNIT_M);
        const gy = Math.floor(state.cursorWorld.y / STATION_UNIT_M);
        const ghostMod: PlacedModule = {
          id: '__ghost_mod',
          type: def.id,
          gx,
          gy,
          floor: state.focusFloor,
          rotation: tool.rotation,
        };
        ghostConns.push(...getModuleWorldConnectors(ghostMod, def));
      }
    } else if (tool.kind === 'stamp-blueprint') {
      for (const m of tool.blueprint.modules) {
        const def = getModuleDef(m.type);
        if (!def) continue;
        for (const c of def.connectors) heldTypes.add(c.type);
      }
    }

    // Index ghost connectors for live mated-lock detection
    const ghostByKey = new Map<string, WorldConnector[]>();
    for (const gc of ghostConns) {
      const k = connectorKey(gc.x, gc.y, gc.floor);
      const list = ghostByKey.get(k);
      if (list) list.push(gc);
      else ghostByKey.set(k, [gc]);
    }

    const matchSealsPts: number[] = [];

    for (const c of this.cachedAllConnectors) {
      const isVertical = c.type.startsWith('Vertical');
      // Show horizontal open sockets on focusFloor; show vertical sockets on focusFloor or adjacent floors
      if (!isVertical && c.floor !== state.focusFloor) continue;
      if (isVertical && Math.abs(c.floor - state.focusFloor) > 1) continue;

      const key = connectorKey(c.x, c.y, c.floor);
      if (!isVertical && (this.cachedConnCounts.get(key) ?? 0) >= 2) continue; // Already mated

      const compatible = heldTypes.size === 0 || heldTypes.has(c.type);
      const cyWorld = c.floor * FLOOR_VISUAL_SPACING + 0.13;

      if (isVertical) {
        if (!compatible) continue;
        const r = c.type === 'Vertical2x2' ? 3.7 : 2.1;
        const pts = [
          c.x, cyWorld, c.y - r, c.x + r, cyWorld, c.y,
          c.x + r, cyWorld, c.y, c.x, cyWorld, c.y + r,
          c.x, cyWorld, c.y + r, c.x - r, cyWorld, c.y,
          c.x - r, cyWorld, c.y, c.x, cyWorld, c.y - r,
        ];
        this.dockHintsGroup.add(
          createCrispLineSegments(pts, {
            color: palette.connVertical,
            opacity: c.floor === state.focusFloor ? 0.95 : 0.45,
            widthPx: 1.5,
          })
        );
        continue;
      }

      // Check whether hovered ghost docks flush & opposite-facing onto this open socket!
      const matchingGhosts = ghostByKey.get(key);
      const isLockedNow =
        matchingGhosts?.some((gc) => gc.type === c.type && (gc.rotation + 2) % 4 === c.rotation) ?? false;

      if (isLockedNow) {
        const span = c.type === 'XLarge' ? 18.6 : 5.8;
        const hs = span / 2;
        const cosR = Math.cos(c.rotation * (Math.PI / 2));
        const sinR = Math.sin(c.rotation * (Math.PI / 2));
        const tx = -sinR;
        const tz = cosR;
        const nx = cosR;
        const nz = sinR;
        // Bold twin-bar mated lock seal right across the aligned seam
        for (const off of [-0.32, 0.32]) {
          matchSealsPts.push(
            c.x + nx * off - tx * hs, cyWorld + 0.04, c.y + nz * off - tz * hs,
            c.x + nx * off + tx * hs, cyWorld + 0.04, c.y + nz * off + tz * hs
          );
        }
        // Center diamond lock emblem
        const dr = 0.95;
        matchSealsPts.push(
          c.x + nx * dr, cyWorld + 0.04, c.y + nz * dr, c.x + tx * dr, cyWorld + 0.04, c.y + tz * dr,
          c.x + tx * dr, cyWorld + 0.04, c.y + tz * dr, c.x - nx * dr, cyWorld + 0.04, c.y - nz * dr,
          c.x - nx * dr, cyWorld + 0.04, c.y - nz * dr, c.x - tx * dr, cyWorld + 0.04, c.y - tz * dr,
          c.x - tx * dr, cyWorld + 0.04, c.y - tz * dr, c.x + nx * dr, cyWorld + 0.04, c.y + nz * dr
        );
        continue;
      }

      const isXL = c.type === 'XLarge';
      const span = isXL ? 18 : 5.2;
      const col = compatible ? (isXL ? palette.connXLarge : palette.validGhost) : palette.connLarge;
      const mark = createStationConnectorMark(
        span,
        col,
        compatible ? 0.92 : 0.32,
        compatible ? 'hint-match' : 'hint-dim'
      );
      mark.position.set(c.x, cyWorld, c.y);
      mark.rotation.y = -c.rotation * (Math.PI / 2);
      this.dockHintsGroup.add(mark);
    }

    if (matchSealsPts.length >= 6) {
      this.dockHintsGroup.add(
        createCrispLineSegments(matchSealsPts, {
          color: palette.dockMatchHint,
          opacity: 1.0,
          widthPx: 1.9,
        })
      );
    }
  }

  private addGhostConnectors(
    target: THREE.Group,
    mod: PlacedModule,
    def: StationModuleDef,
    palette: CadThemePalette,
    ghostColor: number
  ): void {
    for (const c of getModuleWorldConnectors(mod, def)) {
      const cyWorld = c.floor * FLOOR_VISUAL_SPACING + 0.1;
      if (c.type.startsWith('Vertical')) {
        const r = c.type === 'Vertical2x2' ? 3.2 : 1.7;
        const pts = [
          c.x, cyWorld, c.y - r, c.x + r, cyWorld, c.y,
          c.x + r, cyWorld, c.y, c.x, cyWorld, c.y + r,
          c.x, cyWorld, c.y + r, c.x - r, cyWorld, c.y,
          c.x - r, cyWorld, c.y, c.x, cyWorld, c.y - r,
        ];
        target.add(createCrispLineSegments(pts, { color: ghostColor, opacity: 0.96, widthPx: 1.4 }));
      } else {
        const isXL = c.type === 'XLarge';
        const span = isXL ? 18 : 5.2;
        const col = isXL ? palette.connXLarge : ghostColor;
        const mark = createStationConnectorMark(span, col, 0.96, 'ghost');
        mark.position.set(c.x, cyWorld, c.y);
        mark.rotation.y = -c.rotation * (Math.PI / 2);
        target.add(mark);
      }
    }
  }

  private getCurrentExtrusionScale(): number {
    const pitchDeg = THREE.MathUtils.radToDeg(this.rig.currentPitchRad);
    const t = THREE.MathUtils.clamp((86.5 - pitchDeg) / (86.5 - 77.0), 0, 1);
    const smooth = t * t * (3 - 2 * t);
    return 0.008 + smooth * 0.992;
  }

  private applyExtrusionScale(yScale: number): void {
    for (const bucket of this.floorBuckets.values()) {
      if (bucket.root.visible) {
        bucket.applyExtrusion(yScale);
      }
    }
    for (const g of this.ghostExtrudeTargets) {
      g.scale.y = yScale;
    }
  }

  private computeDistanceLod(): number {
    const dist = this.rig.currentDistance;
    return THREE.MathUtils.clamp(1.0 - (dist - 55) / 85, 0.3, 1.0);
  }

  private applyDistanceLodAndFog(): void {
    const dist = this.rig.currentDistance;
    const lod = this.computeDistanceLod();
    if (Math.abs(lod - this.lastDetailLod) > 0.012) {
      this.lastDetailLod = lod;
      for (const bucket of this.floorBuckets.values()) {
        bucket.applyDetailLodOnly(lod);
      }
    }

    // Attenuate atmospheric fog cleanly on macro overview zoom so 560m mega-stations stay crystal clear!
    if (this.scene.fog instanceof THREE.FogExp2) {
      const baseDensity = this.activePalette.isLight ? 0.00008 : 0.00018;
      const farAtten = THREE.MathUtils.clamp(1.0 - (dist - 160) / 300, 0.05, 1.0);
      this.scene.fog.density = baseDensity * farAtten;
    }
  }

  private updateRoundedGrid(state: SceneRenderState): void {
    const u = this.roundedGrid.uniforms;
    this.roundedGrid.mesh.position.y = state.focusFloor * FLOOR_VISUAL_SPACING + 0.018;

    const isStation = state.viewMode === 'station';
    u.uCellSize.value = isStation ? STATION_UNIT_M : 1.0;
    u.uCursorRadius.value = isStation ? 44.0 : 6.8;
    u.uCornerRadius.value = isStation ? 0.06 : 0.14;

    const showForTool =
      state.activeTool.kind !== 'select' || state.boxSelectRect !== null || state.beltPreview.length > 0;
    if (state.cursorWorld) {
      u.uCursorWorld.value.set(state.cursorWorld.x, state.cursorWorld.y);
      u.uCursorActive.value = 1.0;
      u.uOpacity.value = showForTool ? 0.64 : isStation ? 0.3 : 0.42;
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

  private addFlatRectGhost(x0: number, z0: number, x1: number, z1: number, y: number, color: number, opacity = 0.88): void {
    const pts = [
      x0, y, z0, x1, y, z0,
      x1, y, z0, x1, y, z1,
      x1, y, z1, x0, y, z1,
      x0, y, z1, x0, y, z0,
    ];
    this.previewGroup.add(createCrispLineSegments(pts, { color, opacity, widthPx: 1.3 }));
  }

  private rebuildPreview(state: SceneRenderState, palette: CadThemePalette): void {
    this.clearGroup(this.previewGroup);
    this.ghostExtrudeTargets = [];
    const yScale = this.getCurrentExtrusionScale();

    if (state.beltPreview.length > 0 && state.activeTool.kind === 'place-building') {
      const beltType = state.activeTool.buildingType;
      const baseY = state.focusFloor * FLOOR_VISUAL_SPACING + 0.07;
      for (const seg of state.beltPreview) {
        const issue = validateBuildingPlacement(
          state.doc,
          { type: beltType, x: seg.x, y: seg.y, floor: state.focusFloor, rotation: seg.rotation },
          { allowBeltReplace: true }
        );
        const col = issue ? palette.invalidGhost : palette.validGhost;
        this.addFlatRectGhost(seg.x + 0.14, seg.y + 0.14, seg.x + 0.86, seg.y + 0.86, baseY, col, 0.6);
        const chev = createDirectionalChevron(0.28, col, 0.94);
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
      const col = issue ? palette.invalidGhost : palette.validGhost;
      const x0 = gx * STATION_UNIT_M + 0.12;
      const z0 = gy * STATION_UNIT_M + 0.12;
      const x1 = (gx + wu) * STATION_UNIT_M - 0.12;
      const z1 = (gy + du) * STATION_UNIT_M - 0.12;

      const ghostMod: PlacedModule = {
        id: '__ghost_mod',
        type: def.id,
        gx,
        gy,
        floor: state.focusFloor,
        rotation: state.activeTool.rotation,
        label: state.activeTool.label,
      };

      if (!def.hasFactoryFloor) {
        const ghostArt = buildStationModuleArt(ghostMod, def, baseY + 0.04, 0.96, false, palette, col);
        ghostArt.extrudeGroup.scale.y = yScale;
        this.ghostExtrudeTargets.push(ghostArt.extrudeGroup);
        this.previewGroup.add(ghostArt.root);
        this.addFlatRectGhost(x0, z0, x1, z1, baseY + 0.06, col, 0.28);
      } else if (def.id === 'BPO_StationCorner_01') {
        const [cx, cy] = getModuleCenterM(ghostMod, def);
        const padSurf: StationFloorSurfaceDef = { ...def.floors[0], minX: -7.9, maxX: 7.9, minY: -7.9, maxY: 7.9 };
        const shapeGeo = createFloorShapeGeometry(padSurf, 3.2);
        const rimLine = createCrispLineSegments(edgesToPositions(new THREE.EdgesGeometry(shapeGeo)), {
          color: col,
          opacity: 0.96,
          widthPx: 1.4,
        });
        shapeGeo.dispose();
        rimLine.position.set(cx, baseY + 0.08, cy);
        rimLine.rotation.y = -ghostMod.rotation * (Math.PI / 2);
        this.previewGroup.add(rimLine);
      } else if (def.id === 'BPO_Dock_2') {
        const ghostGantry = buildIndustrialDockGantryArt(ghostMod, def, baseY + 0.04, 0.96, false, palette, col);
        ghostGantry.extrudeGroup.scale.y = yScale;
        this.ghostExtrudeTargets.push(ghostGantry.extrudeGroup);
        this.previewGroup.add(ghostGantry.root);
        this.addFlatRectGhost(x0, z0, x1, z1, baseY + 0.08, col, 0.65);
      } else {
        this.addFlatRectGhost(x0, z0, x1, z1, baseY + 0.08, col, 0.94);
        if (hu > 1) {
          this.addFlatRectGhost(x0, z0, x1, z1, baseY + FLOOR_VISUAL_SPACING + 0.08, col, 0.5);
        }
      }

      this.addGhostConnectors(this.previewGroup, ghostMod, def, palette, col);
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
      const col = issue ? palette.invalidGhost : palette.validGhost;
      if (def.kind === 'belt') {
        this.addFlatRectGhost(bx + 0.14, by + 0.14, bx + 0.86, by + 0.86, baseY + 0.09, col, 0.88);
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
          recipeId: state.activeTool.recipeId,
          label: state.activeTool.label,
          disabledPorts: state.activeTool.disabledPorts,
          priorityIn: state.activeTool.priorityIn,
          priorityOut: state.activeTool.priorityOut,
          portFilters: state.activeTool.portFilters,
          filterItems: state.activeTool.filterItems,
        };
        const ghostArt = buildMachineLineArt(ghostBld, def, baseY + 0.05, 0.96, false, palette, col);
        ghostArt.extrudeGroup.scale.y = yScale;
        this.ghostExtrudeTargets.push(ghostArt.extrudeGroup);
        this.previewGroup.add(ghostArt.root);
        this.addFlatRectGhost(bx + 0.04, by + 0.04, bx + w - 0.04, by + d - 0.04, baseY + 0.09, col, 0.72);
      }

      if (def.kind === 'underground') {
        const maxLen = def.maxLength ?? 8;
        const dirSign = state.activeTool.undergroundMode === 'out' ? -1 : 1;
        const dx = state.activeTool.rotation === 0 ? 1 : state.activeTool.rotation === 2 ? -1 : 0;
        const dy = state.activeTool.rotation === 1 ? 1 : state.activeTool.rotation === 3 ? -1 : 0;
        this.previewGroup.add(
          createCrispLineSegments(
            [bx + 0.5, baseY + 0.1, by + 0.5, bx + 0.5 + dx * dirSign * maxLen, baseY + 0.1, by + 0.5 + dy * dirSign * maxLen],
            { color: col, opacity: 0.8, widthPx: 1.15, dashed: true, dashSize: 0.35, gapSize: 0.25 }
          )
        );
      }
      return;
    }

    // 4. Blueprint Stamp Ghost (batched for large stamps!)
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

      const validPts: number[] = [];
      const invalidPts: number[] = [];

      for (const m of modules) {
        const def = getModuleDef(m.type);
        if (!def) continue;
        const issue = validateModulePlacement(state.doc, m);
        const isBad = Boolean(issue && !state.forceReplaceHeld);
        const [minX, minY, maxX, maxY] = getModuleBoundsM(m, def);
        const y = m.floor * FLOOR_VISUAL_SPACING + 0.08;
        const dst = isBad ? invalidPts : validPts;
        dst.push(
          minX + 0.15, y, minY + 0.15, maxX - 0.15, y, minY + 0.15,
          maxX - 0.15, y, minY + 0.15, maxX - 0.15, y, maxY - 0.15,
          maxX - 0.15, y, maxY - 0.15, minX + 0.15, y, maxY - 0.15,
          minX + 0.15, y, maxY - 0.15, minX + 0.15, y, minY + 0.15
        );
        if (modules.length <= 24) {
          this.addGhostConnectors(this.previewGroup, m, def, palette, isBad ? palette.invalidGhost : palette.validGhost);
        }
      }

      for (const b of buildings) {
        const def = getBuildableDef(b.type);
        if (!def) continue;
        const issue = validateBuildingPlacement(tempDoc, b, {
          allowBeltReplace: true,
          allowForceReplace: state.forceReplaceHeld,
        });
        const [w, d] = getBuildingSizeCells(def, b.rotation);
        const y = b.floor * FLOOR_VISUAL_SPACING + 0.09;
        const dst = issue ? invalidPts : validPts;
        dst.push(
          b.x + 0.1, y, b.y + 0.1, b.x + w - 0.1, y, b.y + 0.1,
          b.x + w - 0.1, y, b.y + 0.1, b.x + w - 0.1, y, b.y + d - 0.1,
          b.x + w - 0.1, y, b.y + d - 0.1, b.x + 0.1, y, b.y + d - 0.1,
          b.x + 0.1, y, b.y + d - 0.1, b.x + 0.1, y, b.y + 0.1
        );
      }

      if (validPts.length >= 6) {
        this.previewGroup.add(createCrispLineSegments(validPts, { color: palette.validGhost, opacity: 0.88, widthPx: 1.3 }));
      }
      if (invalidPts.length >= 6) {
        this.previewGroup.add(createCrispLineSegments(invalidPts, { color: palette.invalidGhost, opacity: 0.9, widthPx: 1.35 }));
      }
    }
  }

  private rebuildBoxSelect(state: SceneRenderState, palette: CadThemePalette): void {
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
      new THREE.MeshBasicMaterial({ color: palette.selectOutline, transparent: true, opacity: 0.06, depthWrite: false })
    );
    fill.position.set(cx, (y0 + y1) / 2, cy);
    this.boxSelectGroup.add(fill);

    const edges = createCrispLineSegments(edgesToPositions(new THREE.EdgesGeometry(geo)), {
      color: palette.selectOutline,
      opacity: 0.84,
      widthPx: 1.25,
    });
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
    this.applyExtrusionScale(this.getCurrentExtrusionScale());
    this.applyDistanceLodAndFog();
    this.renderer.render(this.scene, this.rig.camera);
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    this.clearFloorBuckets();
    this.clearGroup(this.referenceGroup);
    this.clearGroup(this.selectionGroup);
    this.clearGroup(this.dockHintsGroup);
    this.clearGroup(this.previewGroup);
    this.clearGroup(this.boxSelectGroup);
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
