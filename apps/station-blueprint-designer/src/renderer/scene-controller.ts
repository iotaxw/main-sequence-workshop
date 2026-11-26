import * as THREE from 'three';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { getMatchingUndergroundType, type BeltCellSpec } from '../core/belt-router';
import { getBuildableDef, getItemNameZh, getModuleDef, getRecipeDef } from '../core/catalog';
import { getBlueprintBoundsM } from '../core/commands';
import {
  areWorldConnectorsMated,
  collectOpenGhostConnectors,
  computeUndergroundLinks,
  findBuildingAtCell,
  findModuleAtWorldPoint,
  FLOOR_VISUAL_SPACING,
  getBuildingCenterM,
  getBuildingSizeCells,
  getBuildingSpatialIndex,
  getDocSpatialIndex,
  getModuleBoundsM,
  getModuleCenterM,
  getModuleSizeUnits,
  getModuleSpatialIndex,
  getModuleWorldConnectors,
  getWorldConnectorKey,
  isCellBuildable,
  packCellKey,
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
  PlacedBuilding,
  PlacedModule,
  SelectionLayerMode,
  SelectionState,
  StationFloorSurfaceDef,
  StationModuleDef,
  ViewMode,
} from '../core/types';
import { CadCameraRig } from './camera-rig';
import {
  createCrispLineSegments,
  setLineViewportResolution,
  withDeferredLines,
  type CrispLineOptions,
} from './crisp-lines';
import {
  buildIndustrialDockGantryArt,
  buildMachineLineArt,
  buildStationModuleArt,
  emitBeltsMergedToBuffers,
} from './line-art';
import { createRoundedGridOverlay } from './rounded-grid-shader';
import { CAD_THEMES, type CadThemeId, type CadThemePalette } from './theme';

export type BoxSelectMode = 'replace' | 'add' | 'sub' | 'demolish';

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
  beltPreview: BeltCellSpec[];
  boxSelectRect: { minX: number; minY: number; maxX: number; maxY: number } | null;
  forceReplaceHeld: boolean;
  simulationIssues?: Array<{
    floor: number;
    x: number;
    y: number;
    severity: 'error' | 'warn';
    code?: string;
    active?: boolean;
  }>;
}

const labelTextureCache = new Map<string, THREE.CanvasTexture>();

// Shared unit XZ plane geometry for ALL station & building labels (zero per-label BufferGeometry alloc!)
const SHARED_LABEL_PLANE_GEO = (() => {
  const g = new THREE.PlaneGeometry(1, 0.375);
  g.rotateX(-Math.PI / 2);
  return g;
})();

const BUILDING_CHUNK_SIZE_M = 96; // 6 x 6 station units (~32 chunks on a 560m mega-station: tight foreground/horizon LOD + fast single-chunk edits!)
const _frustum = new THREE.Frustum();
const _projScreenMat = new THREE.Matrix4();

function chunkCoord(worldM: number): number {
  return Math.floor(worldM / BUILDING_CHUNK_SIZE_M);
}

function packChunkKey(floor: number, cx: number, cy: number): string {
  return `${floor}:${cx},${cy}`;
}

function getLabelTexture(
  title: string,
  subtitle: string | null,
  palette: CadThemePalette,
  maxAniso = 8
): THREE.CanvasTexture {
  const key = `${palette.id}||${title}||${subtitle ?? ''}`;
  const cached = labelTextureCache.get(key);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 192;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = palette.labelTitleHex;
  ctx.font = '500 42px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
  const yTitle = subtitle ? 66 : 96;
  ctx.fillText(title.slice(0, 10), 256, yTitle, 470);

  if (subtitle) {
    ctx.fillStyle = palette.labelSubHex;
    ctx.font = '400 33px "JetBrains Mono", Consolas, "Microsoft YaHei", monospace';
    ctx.fillText(subtitle.slice(0, 14), 256, 133, 470);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = Math.min(8, Math.max(4, maxAniso));
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

const _scratchV3 = new THREE.Vector3();
const _scratchInvFlat = new THREE.Matrix4();
const _scratchInvExtrude = new THREE.Matrix4();
const _scratchRelMat = new THREE.Matrix4();

function pushFlatRectPts(out: number[], x0: number, z0: number, x1: number, z1: number, y: number): void {
  out.push(
    x0, y, z0, x1, y, z0,
    x1, y, z0, x1, y, z1,
    x1, y, z1, x0, y, z1,
    x0, y, z1, x0, y, z0
  );
}

function pushRotatedChevronPts(
  out: number[],
  cx: number,
  y: number,
  cz: number,
  size: number,
  rotation: 0 | 1 | 2 | 3
): void {
  const xBack = -size * 0.45;
  const xTip = size * 0.5;
  const zHalf = size * 0.45;
  const toWX = (lx: number, lz: number) =>
    cx + (rotation === 0 ? lx : rotation === 1 ? -lz : rotation === 2 ? -lx : lz);
  const toWZ = (lx: number, lz: number) =>
    cz + (rotation === 0 ? lz : rotation === 1 ? lx : rotation === 2 ? -lz : -lx);
  const tipX = toWX(xTip, 0);
  const tipZ = toWZ(xTip, 0);
  out.push(
    toWX(xBack, -zHalf), y, toWZ(xBack, -zHalf), tipX, y, tipZ,
    tipX, y, tipZ, toWX(xBack, zHalf), y, toWZ(xBack, zHalf)
  );
}

function pushStationConnectorMarkPts(
  out: number[],
  cx: number,
  y: number,
  cz: number,
  rotation: 0 | 1 | 2 | 3,
  span: number,
  mode: 'open' | 'mated' | 'ghost' | 'hint-match' | 'hint-dim'
): void {
  const hs = span / 2;
  const toWX = (lx: number, lz: number) =>
    cx + (rotation === 0 ? lx : rotation === 1 ? -lz : rotation === 2 ? -lx : lz);
  const toWZ = (lx: number, lz: number) =>
    cz + (rotation === 0 ? lz : rotation === 1 ? lx : rotation === 2 ? -lz : -lx);
  const seg = (x1: number, z1: number, x2: number, z2: number) => {
    out.push(toWX(x1, z1), y, toWZ(x1, z1), toWX(x2, z2), y, toWZ(x2, z2));
  };

  if (mode === 'mated') {
    seg(0, -hs * 0.72, 0, hs * 0.72);
    return;
  }
  if (mode === 'hint-match') {
    seg(-0.1, -hs, -0.1, hs);
    seg(0.22, -hs, 0.22, hs);
    seg(-0.45, -hs, 0.95, -hs);
    seg(-0.45, hs, 0.95, hs);
    seg(0.22, -0.85, 1.55, 0);
    seg(1.55, 0, 0.22, 0.85);
    seg(2.3, 0, 4.2, 0);
    return;
  }
  const tickIn = 0.3;
  const arrowOut = mode === 'ghost' ? 1.0 : mode === 'hint-dim' ? 0.5 : 0.48;
  seg(-0.06, -hs, -0.06, hs);
  seg(-tickIn, -hs, -0.06, -hs);
  seg(-tickIn, hs, -0.06, hs);
  seg(-0.06, -0.48, arrowOut, 0);
  seg(arrowOut, 0, -0.06, 0.48);
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
  lodTier: 'primary' | 'detail' | 'micro';
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
  lodTier?: 'primary' | 'detail' | 'micro';
  obj?: THREE.Object3D;
}

interface LabelEntry {
  mesh: THREE.Mesh;
  roofHeight: number;
  baseOffsetY: number;
  alphaScale: number;
}

/**
 * Per-(floor, 64m×64m chunk) batched render bucket.
 * - Enables chunk-level Three.js frustum culling (skips 90–96% of off-screen mega-station geometry & labels!)
 * - Enables ~60x faster incremental single-chunk edits on 29,000+ building blueprints
 * - Lazy dirty visual sync: culled chunks do ZERO CPU work during orbit, pan, zoom, or pitch tilt!
 */
class RenderChunkBucket {
  readonly floor: number;
  readonly chunkKey: string;
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
  readonly worldBounds = new THREE.Box3();
  isEmpty = true;
  gpuWarmed = false;
  isDisposed = false;

  private minX = Infinity;
  private minZ = Infinity;
  private maxX = -Infinity;
  private maxZ = -Infinity;
  private maxYRel = 1.0;

  private lineAccums = new Map<string, LineBucketAccum>();
  private meshAccums = new Map<string, MeshBucketAccum>();

  // Cached last-applied visual state for zero-cost lazy sync on visible chunks
  private appliedOpacity = -1;
  private appliedViewMode: ViewMode | '' = '';
  private appliedPrimaryLod = -1;
  private appliedDetailLod = -1;
  private appliedMicroLod = -1;
  private appliedExtrusion = -1;
  private appliedShowStLabels = false;
  private appliedShowBldLabels = false;
  private appliedShowExtruded = true;

  constructor(floor: number, chunkKey: string) {
    this.floor = floor;
    this.chunkKey = chunkKey;
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

  private expandBounds(x: number, yRel: number, z: number): void {
    if (x < this.minX) this.minX = x;
    if (x > this.maxX) this.maxX = x;
    if (z < this.minZ) this.minZ = z;
    if (z > this.maxZ) this.maxZ = z;
    if (yRel > this.maxYRel) this.maxYRel = yRel;
  }

  addLineSegments(
    pts: number[],
    layer: BatchLayer,
    subMode: BatchSubMode,
    opts: {
      color: number;
      widthPx?: number;
      lodTier?: 'primary' | 'detail' | 'micro';
      dashed?: boolean;
      dashSize?: number;
      gapSize?: number;
      alphaScale?: number;
    }
  ): void {
    if (pts.length < 6) return;
    const acc = this.getOrCreateLineAccum(layer, subMode, opts);
    const out = acc.positions;
    for (let i = 0; i < pts.length; i += 3) {
      const x = pts[i];
      const y = pts[i + 1];
      const z = pts[i + 2];
      out.push(x, y, z);
      this.expandBounds(x, y, z);
    }
  }

  addRawTriangles(
    pts: number[],
    layer: BatchLayer,
    subMode: BatchSubMode,
    color: number,
    alphaScale = 0.92,
    alwaysTransparent = false,
    doubleSide = false
  ): void {
    if (pts.length < 9) return;
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
    for (let i = 0; i < pts.length; i += 3) {
      const x = pts[i];
      const y = pts[i + 1];
      const z = pts[i + 2];
      out.push(x, y, z);
      this.expandBounds(x, y, z);
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
    const v = _scratchV3;
    const index = geo.index;
    if (index) {
      for (let i = 0; i < index.count; i++) {
        const idx = index.getX(i);
        v.fromBufferAttribute(posAttr, idx).applyMatrix4(matrix);
        out.push(v.x, v.y, v.z);
        this.expandBounds(v.x, v.y, v.z);
      }
    } else {
      for (let i = 0; i < posAttr.count; i++) {
        v.fromBufferAttribute(posAttr, i).applyMatrix4(matrix);
        out.push(v.x, v.y, v.z);
        this.expandBounds(v.x, v.y, v.z);
      }
    }
  }

  private getOrCreateLineAccum(
    layer: BatchLayer,
    subMode: BatchSubMode,
    opts: {
      color: number;
      widthPx?: number;
      lodTier?: 'primary' | 'detail' | 'micro';
      dashed?: boolean;
      dashSize?: number;
      gapSize?: number;
      alphaScale?: number;
    }
  ): LineBucketAccum {
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
    return acc;
  }

  /**
   * Flattens an entire temporary Object3D subtree (produced by line-art builders) into this chunk's merged buffers
   * and disposes the temporary geometries/materials immediately!
   */
  ingestObject(
    obj: THREE.Object3D,
    extrudeSubtree: THREE.Object3D | null,
    subMode: BatchSubMode = 'always'
  ): void {
    obj.updateMatrixWorld(true);
    const invFlatOffset = _scratchInvFlat.makeTranslation(0, -this.baseY, 0);
    const invExtrudeOffset = _scratchInvExtrude.makeTranslation(0, -(this.baseY + 0.038), 0);
    const relMat = _scratchRelMat;
    const v = _scratchV3;

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
        const acc = this.getOrCreateLineAccum(layer, subMode, {
          color: opts.color ?? 0xcbd8e6,
          widthPx: opts.widthPx,
          lodTier: opts.lodTier,
          dashed: opts.dashed,
          dashSize: opts.dashSize,
          gapSize: opts.gapSize,
          alphaScale: opts.opacity ?? 1.0,
        });
        const out = acc.positions;
        for (let i = 0; i < rawPts.length; i += 3) {
          v.set(rawPts[i], rawPts[i + 1], rawPts[i + 2]).applyMatrix4(relMat);
          out.push(v.x, v.y, v.z);
          this.expandBounds(v.x, v.y, v.z);
        }
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
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: alphaScale,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(SHARED_LABEL_PLANE_GEO, mat);
    mesh.scale.set(width, 1, width);
    mesh.position.set(cx, baseOffsetY + roofHeight, cz);
    if (kind === 'station') this.stationLabels.add(mesh);
    else this.buildingLabels.add(mesh);
    this.labelEntries.push({ mesh, roofHeight, baseOffsetY, alphaScale });
    const hw = width * 0.5;
    this.expandBounds(cx - hw, baseOffsetY + roofHeight, cz - hw * 0.375);
    this.expandBounds(cx + hw, baseOffsetY + roofHeight, cz + hw * 0.375);
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
      geo.computeBoundingSphere();
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
        obj: segs,
      });
    }
    this.lineAccums.clear();

    this.isEmpty = !Number.isFinite(this.minX) || (this.materials.length === 0 && this.labelEntries.length === 0);
    if (!this.isEmpty) {
      this.worldBounds.min.set(this.minX - 2, this.baseY - 1, this.minZ - 2);
      this.worldBounds.max.set(
        this.maxX + 2,
        this.baseY + Math.max(FLOOR_VISUAL_SPACING, this.maxYRel + 2),
        this.maxZ + 2
      );
    }
  }

  /**
   * Lazy dirty-sync called ONLY for frustum-visible chunks!
   * Updates sub-mode visibility, material opacity, LOD visibility, label distance culling,
   * and 3D extrusion scale ONLY when the respective parameter actually changed.
   */
  syncVisuals(
    opacity: number,
    viewMode: ViewMode,
    detailLod: number,
    microLod: number,
    yScale: number,
    cameraDist: number,
    primaryLod = 1.0,
    showExtruded = true
  ): void {
    const showStLabels = viewMode === 'station' && opacity >= 0.45 && cameraDist <= 240;
    const showBldLabels = viewMode === 'building' && opacity >= 0.45 && cameraDist <= 78;

    if (this.appliedViewMode !== viewMode) {
      this.appliedViewMode = viewMode;
      this.flatStation.visible = viewMode === 'station';
      this.flatBuilding.visible = viewMode === 'building';
    }
    if (this.appliedShowExtruded !== showExtruded) {
      this.appliedShowExtruded = showExtruded;
      this.extrudedAlways.visible = showExtruded;
    }
    if (this.appliedShowStLabels !== showStLabels) {
      this.appliedShowStLabels = showStLabels;
      this.stationLabels.visible = showStLabels;
    }
    if (this.appliedShowBldLabels !== showBldLabels) {
      this.appliedShowBldLabels = showBldLabels;
      this.buildingLabels.visible = showBldLabels;
    }

    const opChanged = Math.abs(opacity - this.appliedOpacity) > 0.002;
    const primaryLodChanged = Math.abs(primaryLod - this.appliedPrimaryLod) > 0.01;
    const lodChanged =
      primaryLodChanged ||
      Math.abs(detailLod - this.appliedDetailLod) > 0.01 ||
      Math.abs(microLod - this.appliedMicroLod) > 0.01;

    if (opChanged || lodChanged) {
      for (let i = 0; i < this.materials.length; i++) {
        const entry = this.materials[i];
        if (entry.isLine) {
          if (!opChanged && !primaryLodChanged && entry.lodTier === 'primary') continue;
          const lineMat = entry.mat as LineMaterial;
          const lodMult =
            entry.lodTier === 'micro'
              ? microLod
              : entry.lodTier === 'detail'
                ? detailLod
                : primaryLod;
          const nextOp = opacity * entry.alphaScale * lodMult;
          lineMat.opacity = nextOp;
          if (entry.obj) entry.obj.visible = nextOp > 0.008;
        } else if (opChanged) {
          const meshMat = entry.mat as THREE.MeshBasicMaterial;
          const shouldBeTrans = entry.alwaysTransparent || opacity < 0.99;
          if (meshMat.transparent !== shouldBeTrans) {
            meshMat.transparent = shouldBeTrans;
            meshMat.depthWrite = !shouldBeTrans;
          }
          meshMat.opacity = opacity * entry.alphaScale;
        }
      }
      if (opChanged) {
        for (let i = 0; i < this.labelEntries.length; i++) {
          const lbl = this.labelEntries[i];
          (lbl.mesh.material as THREE.MeshBasicMaterial).opacity = opacity * lbl.alphaScale;
        }
      }
      this.appliedOpacity = opacity;
      this.appliedPrimaryLod = primaryLod;
      this.appliedDetailLod = detailLod;
      this.appliedMicroLod = microLod;
    }

    if (Math.abs(yScale - this.appliedExtrusion) > 1e-4) {
      this.appliedExtrusion = yScale;
      this.extrudedAlways.scale.y = yScale;
      for (let i = 0; i < this.labelEntries.length; i++) {
        const lbl = this.labelEntries[i];
        lbl.mesh.position.y = lbl.baseOffsetY + lbl.roofHeight * yScale;
      }
    }
  }

  dispose(): void {
    this.isDisposed = true;
    this.root.traverse((obj) => {
      const geo = (obj as THREE.Mesh).geometry;
      if (geo && geo !== SHARED_LABEL_PLANE_GEO) {
        geo.dispose();
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
  private rafRunning = false;
  private dirty = true;
  private lastTime = 0;
  private idleUntilMs = 0;
  private disposed = false;

  private referenceGroup = new THREE.Group();
  private worldGroup = new THREE.Group();
  private selectionGroup = new THREE.Group();
  private dockHintsGroup = new THREE.Group();
  private previewGroup = new THREE.Group();
  private boxSelectGroup = new THREE.Group();
  private roundedGrid: ReturnType<typeof createRoundedGridOverlay>;

  private stationFloorBuckets = new Map<number, RenderChunkBucket>();
  private buildingChunkBuckets = new Map<string, RenderChunkBucket>();
  private cachedAllConnectors: WorldConnector[] = [];
  private cachedConnCounts = new Map<string, number>();

  private keysDown = new Set<string>();
  private lastState: SceneRenderState | null = null;
  private liveCursorWorld: { x: number; y: number } | null = null;
  private liveBoxRect: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  private liveBoxMode: BoxSelectMode = 'replace';
  private livePreviewSelection: SelectionState | null = null;
  private liveBeltPreview: BeltCellSpec[] | null = null;
  private cameraDragging = false;
  private lastLiveSelSig = '';
  private lastPreviewKey = '';
  private lastDockHintKey = '';
  private bpRevIds = new WeakMap<BlueprintDocument, number>();
  private nextBpRevId = 1;
  private activePalette: CadThemePalette = CAD_THEMES['platinum-gold'];
  private maxAniso = 8;

  private ghostExtrudeTargets: THREE.Group[] = [];
  private lastExtrusionScale = -1;
  private warmupScene = new THREE.Scene();
  private uploadedTextures = new WeakSet<THREE.CanvasTexture>();
  private pendingTextureUploads: THREE.CanvasTexture[] = [];
  private pendingWarmupBuckets: RenderChunkBucket[] = [];

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
    // Share exact FogExp2 instance so warmupScene compiles/binds the identical USE_FOG programs as main scene!
    this.warmupScene.fog = this.scene.fog;

    const hemi = new THREE.HemisphereLight(0xb8cade, this.activePalette.bg, 0.9);
    this.scene.add(hemi);

    this.rig = new CadCameraRig(initW / Math.max(1, initH), {
      ...callbacks,
      onDirty: () => this.requestRender(),
    });

    this.roundedGrid = createRoundedGridOverlay();
    this.scene.add(this.referenceGroup);
    this.scene.add(this.worldGroup);
    this.scene.add(this.selectionGroup);
    this.scene.add(this.dockHintsGroup);
    this.scene.add(this.roundedGrid.mesh);
    this.scene.add(this.previewGroup);
    this.scene.add(this.boxSelectGroup);

    this.buildMinimalReferenceAxes(this.activePalette);
    this.prewarmShaders();
    this.requestRender();
  }

  /** Pre-compile all custom & standard GLSL shaders (SDF lines, rounded grid, matte + label meshes) once at startup. */
  private prewarmShaders(): void {
    const dummySolid = createCrispLineSegments([0, 0, 0, 1, 0, 0], { color: 0xffffff, opacity: 1, widthPx: 1.2 });
    const dummyDashed = createCrispLineSegments([0, 0, 0, 1, 0, 0], {
      color: 0xffffff,
      opacity: 1,
      widthPx: 1.2,
      dashed: true,
    });
    const dummyMatteGeo = new THREE.BufferGeometry();
    dummyMatteGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 0, 1], 3));
    const dummyMatteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const dummyMatte = new THREE.Mesh(dummyMatteGeo, dummyMatteMat);
    const dummyTex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    dummyTex.needsUpdate = true;
    const dummyLabelMat = new THREE.MeshBasicMaterial({ map: dummyTex, transparent: true, depthWrite: false });
    const dummyLabel = new THREE.Mesh(SHARED_LABEL_PLANE_GEO, dummyLabelMat);

    const prevGridVis = this.roundedGrid.mesh.visible;
    this.roundedGrid.mesh.visible = true;
    this.scene.add(dummySolid, dummyDashed, dummyMatte, dummyLabel);
    this.renderer.compile(this.scene, this.rig.camera);
    this.scene.remove(dummySolid, dummyDashed, dummyMatte, dummyLabel);
    this.roundedGrid.mesh.visible = prevGridVis;
    dummySolid.geometry.dispose();
    dummySolid.material.dispose();
    dummyDashed.geometry.dispose();
    dummyDashed.material.dispose();
    dummyMatteGeo.dispose();
    dummyMatteMat.dispose();
    dummyLabelMat.dispose();
    dummyTex.dispose();
  }

  private queueTextureWarmup(tex: THREE.CanvasTexture): void {
    if (this.uploadedTextures.has(tex)) return;
    this.uploadedTextures.add(tex);
    this.pendingTextureUploads.push(tex);
  }

  /**
   * Silently upload 1 bucket's GPU VBOs & initialize its WebGL VAOs inside a 1×1 color/depth-masked
   * scissor pass during idle frames so orbiting to new chunks or switching floors NEVER spikes!
   */
  private warmupBucketGpu(bucket: RenderChunkBucket): void {
    if (bucket.isDisposed || bucket.isEmpty || bucket.gpuWarmed) return;
    bucket.gpuWarmed = true;

    const gl = this.renderer.getContext();
    const prevAutoClear = this.renderer.autoClear;
    const prevScissorTest = this.renderer.getScissorTest();
    const savedVis: Array<{ obj: THREE.Object3D; vis: boolean; cull: boolean }> = [];
    bucket.root.traverse((obj) => {
      savedVis.push({ obj, vis: obj.visible, cull: obj.frustumCulled });
      obj.visible = true;
      obj.frustumCulled = false;
    });

    this.worldGroup.remove(bucket.root);
    this.warmupScene.add(bucket.root);

    this.renderer.autoClear = false;
    this.renderer.setScissorTest(true);
    this.renderer.setScissor(0, 0, 1, 1);
    gl.colorMask(false, false, false, false);
    gl.depthMask(false);
    try {
      this.renderer.render(this.warmupScene, this.rig.camera);
    } finally {
      gl.colorMask(true, true, true, true);
      gl.depthMask(true);
      this.renderer.setScissorTest(prevScissorTest);
      this.renderer.autoClear = prevAutoClear;
      this.renderer.state.reset();
      this.warmupScene.remove(bucket.root);
      this.worldGroup.add(bucket.root);
      for (let i = 0; i < savedVis.length; i++) {
        const s = savedVis[i];
        s.obj.visible = s.vis;
        s.obj.frustumCulled = s.cull;
      }
    }
  }

  /**
   * Demand-driven render trigger with 2.0s VSync grace window:
   * - Waking from idle uses `lastTime = 0` sentinel so frame 1 gets a clean 1/60s step (never dt=0!).
   * - Stays VSync-locked during continuous wheel/orbit bursts (zero wake stutter), then sleeps at 0% GPU/CPU after 2s.
   */
  requestRender(): void {
    if (this.disposed) return;
    this.dirty = true;
    this.idleUntilMs = performance.now() + 2000;
    if (!this.rafRunning) {
      this.rafRunning = true;
      this.lastTime = 0;
      this.rafId = requestAnimationFrame(this.tick);
    }
  }

  setCameraDragging(dragging: boolean): void {
    if (this.cameraDragging === dragging) return;
    this.cameraDragging = dragging;
    if (this.lastState) {
      this.updateRoundedGrid({
        ...this.lastState,
        cursorWorld: this.liveCursorWorld,
        boxSelectRect: this.liveBoxRect,
        beltPreview: this.liveBeltPreview ?? this.lastState.beltPreview,
      });
    }
    this.requestRender();
  }

  private hasMovementKeys(): boolean {
    return (
      this.keysDown.has('KeyD') ||
      this.keysDown.has('ArrowRight') ||
      this.keysDown.has('KeyA') ||
      this.keysDown.has('ArrowLeft') ||
      this.keysDown.has('KeyW') ||
      this.keysDown.has('ArrowUp') ||
      this.keysDown.has('KeyS') ||
      this.keysDown.has('ArrowDown')
    );
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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h);
    setLineViewportResolution(w, h);
    this.rig.setAspect(w / Math.max(1, h));
    this.requestRender();
  }

  setKeyDown(code: string, down: boolean): void {
    if (down) {
      this.keysDown.add(code);
      if (this.hasMovementKeys()) this.requestRender();
    } else {
      this.keysDown.delete(code);
    }
  }

  clearKeys(): void {
    this.keysDown.clear();
  }

  private getOrCreateStationFloorBucket(floor: number): RenderChunkBucket {
    let bucket = this.stationFloorBuckets.get(floor);
    if (!bucket) {
      bucket = new RenderChunkBucket(floor, `st:${floor}`);
      this.stationFloorBuckets.set(floor, bucket);
      this.worldGroup.add(bucket.root);
    }
    return bucket;
  }

  private getOrCreateBuildingChunkBucket(floor: number, cx: number, cy: number): RenderChunkBucket {
    const key = packChunkKey(floor, cx, cy);
    let bucket = this.buildingChunkBuckets.get(key);
    if (!bucket) {
      bucket = new RenderChunkBucket(floor, key);
      this.buildingChunkBuckets.set(key, bucket);
      this.worldGroup.add(bucket.root);
    }
    return bucket;
  }

  private clearWorldBuckets(): void {
    this.pendingWarmupBuckets.length = 0;
    for (const bucket of this.stationFloorBuckets.values()) {
      this.worldGroup.remove(bucket.root);
      bucket.dispose();
    }
    this.stationFloorBuckets.clear();
    for (const bucket of this.buildingChunkBuckets.values()) {
      this.worldGroup.remove(bucket.root);
      bucket.dispose();
    }
    this.buildingChunkBuckets.clear();
  }

  private getBlueprintRevId(bp: BlueprintDocument): number {
    let rev = this.bpRevIds.get(bp);
    if (rev === undefined) {
      rev = this.nextBpRevId++;
      this.bpRevIds.set(bp, rev);
    }
    return rev;
  }

  private computePreviewKey(state: SceneRenderState, cursor: { x: number; y: number } | null): string {
    if (state.beltPreview.length > 0 && state.activeTool.kind === 'place-building') {
      let acc = 2166136261;
      for (let i = 0; i < state.beltPreview.length; i++) {
        const s = state.beltPreview[i];
        const kindCode = s.kind === 'underground-in' ? 1 : s.kind === 'underground-out' ? 2 : 0;
        const mix = (s.x * 73856093) ^ (s.y * 19349663) ^ (s.rotation << 3) ^ (kindCode << 6) ^ (s.isWaypoint ? 512 : 0);
        acc = Math.imul(acc ^ mix, 16777619) >>> 0;
      }
      return `belt:${state.activeTool.buildingType}:${state.focusFloor}:${state.beltPreview.length}:${acc}`;
    }
    const tool = state.activeTool;
    if (!cursor) return 'none';
    if (tool.kind === 'select') {
      if (state.boxSelectRect) return 'none';
      if (state.viewMode === 'station') {
        const gx = Math.floor(cursor.x / STATION_UNIT_M);
        const gy = Math.floor(cursor.y / STATION_UNIT_M);
        return `hov:m:${state.focusFloor}:${gx},${gy}`;
      }
      const cx = Math.floor(cursor.x);
      const cy = Math.floor(cursor.y);
      return `hov:b:${state.focusFloor}:${cx},${cy}`;
    }
    if (tool.kind === 'demolish') {
      if (state.boxSelectRect) return 'none';
      if (state.viewMode === 'station') {
        const gx = Math.floor(cursor.x / STATION_UNIT_M);
        const gy = Math.floor(cursor.y / STATION_UNIT_M);
        return `dem:m:${state.focusFloor}:${gx},${gy}`;
      }
      const cx = Math.floor(cursor.x);
      const cy = Math.floor(cursor.y);
      return `dem:b:${state.focusFloor}:${cx},${cy}`;
    }
    if (tool.kind === 'place-module') {
      const gx = Math.floor(cursor.x / STATION_UNIT_M);
      const gy = Math.floor(cursor.y / STATION_UNIT_M);
      return `mod:${tool.moduleType}:${tool.rotation}:${state.focusFloor}:${gx},${gy}`;
    }
    if (tool.kind === 'place-building') {
      const def = getBuildableDef(tool.buildingType);
      if (!def) return 'none';
      const [w, d] = getBuildingSizeCells(def, tool.rotation);
      const bx = Math.floor(cursor.x - w / 2 + 0.5);
      const by = Math.floor(cursor.y - d / 2 + 0.5);
      return `bld:${tool.buildingType}:${tool.rotation}:${tool.undergroundMode ?? ''}:${state.focusFloor}:${state.forceReplaceHeld ? 1 : 0}:${bx},${by}`;
    }
    // stamp-blueprint
    const hasMods = tool.blueprint.modules.length > 0;
    const ax = hasMods ? Math.floor(cursor.x / STATION_UNIT_M) * STATION_UNIT_M : Math.floor(cursor.x);
    const ay = hasMods ? Math.floor(cursor.y / STATION_UNIT_M) * STATION_UNIT_M : Math.floor(cursor.y);
    const bpRev = this.getBlueprintRevId(tool.blueprint);
    return `stamp:${bpRev}:${tool.rotation}:${tool.floorOffset}:${state.focusFloor}:${state.forceReplaceHeld ? 1 : 0}:${ax},${ay}`;
  }

  private computeDockHintKey(state: SceneRenderState, cursor: { x: number; y: number } | null): string {
    const tool = state.activeTool;
    const isPlacingMod = tool.kind === 'place-module';
    const isStampingMods = tool.kind === 'stamp-blueprint' && tool.blueprint.modules.length > 0;
    if (!isPlacingMod && !isStampingMods) return 'none';
    const gx = cursor ? Math.floor(cursor.x / STATION_UNIT_M) : -99999;
    const gy = cursor ? Math.floor(cursor.y / STATION_UNIT_M) : -99999;
    if (tool.kind === 'place-module') {
      return `mod:${tool.moduleType}:${tool.rotation}:${state.focusFloor}:${gx},${gy}`;
    }
    const bpRev = this.getBlueprintRevId(tool.blueprint);
    return `stamp:${bpRev}:${tool.rotation}:${tool.floorOffset}:${state.focusFloor}:${gx},${gy}`;
  }

  private computeSelectionSig(sel: SelectionState, mode: BoxSelectMode, isLive: boolean): string {
    const ml = sel.moduleIds.length;
    const bl = sel.buildingIds.length;
    const mHead = ml > 0 ? sel.moduleIds[0] : '';
    const mTail = ml > 1 ? sel.moduleIds[ml - 1] : '';
    const bHead = bl > 0 ? sel.buildingIds[0] : '';
    const bTail = bl > 1 ? sel.buildingIds[bl - 1] : '';
    return `${isLive ? mode : 'idle'}|${ml}:${mHead}:${mTail}|${bl}:${bHead}:${bTail}`;
  }

  /**
   * Shapez 2 style real-time area selection & area demolish highlighter (ZERO React re-renders!).
   * Continuously updates the 3D drag box + ground grid glow AND highlights every entity inside
   * the box live as the user drags.
   */
  setLiveBoxSelect(
    rect: { minX: number; minY: number; maxX: number; maxY: number } | null,
    mode: BoxSelectMode = 'replace',
    previewSelection: SelectionState | null = null
  ): void {
    this.liveBoxRect = rect;
    this.liveBoxMode = mode;
    this.livePreviewSelection = rect ? previewSelection : null;

    const state = this.lastState;
    if (!state) return;
    const palette = CAD_THEMES[state.theme];
    const effState: SceneRenderState = {
      ...state,
      cursorWorld: this.liveCursorWorld,
      boxSelectRect: rect,
      beltPreview: this.liveBeltPreview ?? state.beltPreview,
    };

    this.updateRoundedGrid(effState);
    this.rebuildBoxSelect(effState, palette, mode);

    const nextPrevKey = this.computePreviewKey(effState, this.liveCursorWorld);
    if (nextPrevKey !== this.lastPreviewKey) {
      this.lastPreviewKey = nextPrevKey;
      this.rebuildPreview(effState, palette);
    }

    const activeSel = this.livePreviewSelection ?? state.selection;
    const nextSig = this.computeSelectionSig(activeSel, mode, Boolean(rect));
    if (nextSig !== this.lastLiveSelSig) {
      this.lastLiveSelSig = nextSig;
      this.rebuildSelectionOverlay(effState, palette);
    }
    this.requestRender();
  }

  /**
   * Direct high-frequency belt routing preview update WITHOUT triggering React re-renders!
   */
  setLiveBeltPreview(specs: BeltCellSpec[]): void {
    this.liveBeltPreview = specs.length > 0 ? specs : null;
    const state = this.lastState;
    if (!state) return;
    const effState: SceneRenderState = {
      ...state,
      cursorWorld: this.liveCursorWorld,
      boxSelectRect: this.liveBoxRect,
      beltPreview: specs,
    };
    this.updateRoundedGrid(effState);
    const palette = CAD_THEMES[state.theme];
    const nextPrevKey = this.computePreviewKey(effState, this.liveCursorWorld);
    if (nextPrevKey !== this.lastPreviewKey) {
      this.lastPreviewKey = nextPrevKey;
      this.rebuildPreview(effState, palette);
    }
    this.requestRender();
  }

  /**
   * Direct high-frequency cursor update called from pointermove WITHOUT triggering React re-renders!
   * Updates GPU rounded-grid uniform continuously and only rebuilds ghost/dock hints when snapped grid cell changes.
   */
  setCursorWorld(world: { x: number; y: number } | null): void {
    const prev = this.liveCursorWorld;
    if (prev === null && world === null) return;
    if (prev && world && prev.x === world.x && prev.y === world.y) return;
    this.liveCursorWorld = world;
    const state = this.lastState;
    if (!state) return;
    const effState: SceneRenderState = {
      ...state,
      cursorWorld: world,
      boxSelectRect: this.liveBoxRect,
      beltPreview: this.liveBeltPreview ?? state.beltPreview,
    };
    this.updateRoundedGrid(effState);

    const palette = CAD_THEMES[state.theme];
    const nextDockKey = this.computeDockHintKey(effState, world);
    if (nextDockKey !== this.lastDockHintKey) {
      this.lastDockHintKey = nextDockKey;
      this.rebuildDockHints(effState, palette);
    }

    const nextPrevKey = this.computePreviewKey(effState, world);
    if (nextPrevKey !== this.lastPreviewKey) {
      this.lastPreviewKey = nextPrevKey;
      this.rebuildPreview(effState, palette);
    }
    this.requestRender();
  }

  syncState(state: SceneRenderState): void {
    const prev = this.lastState;
    if (state.activeTool.kind !== 'place-building') {
      this.liveBeltPreview = null;
    }
    const effCursor = state.cursorWorld ?? this.liveCursorWorld;
    const effBox = state.boxSelectRect ?? this.liveBoxRect;
    const effBelt = state.beltPreview.length > 0 ? state.beltPreview : (this.liveBeltPreview ?? state.beltPreview);
    const effState: SceneRenderState = {
      ...state,
      cursorWorld: effCursor,
      boxSelectRect: effBox,
      beltPreview: effBelt,
    };
    this.lastState = effState;

    const palette = CAD_THEMES[effState.theme];
    const themeChanged = !prev || prev.theme !== effState.theme;
    if (themeChanged) {
      this.applyThemeToScene(palette);
    }

    this.rig.setFocusFloor(effState.focusFloor);
    this.referenceGroup.position.y = effState.focusFloor * FLOOR_VISUAL_SPACING - 0.06;

    // Incremental per-floor world batch rebuild: skip completely when only metadata (e.g. doc.name) changed!
    const geometryDocChanged =
      !prev || prev.doc.modules !== effState.doc.modules || prev.doc.buildings !== effState.doc.buildings;
    const docOrThemeChanged = themeChanged || geometryDocChanged;
    if (docOrThemeChanged) {
      this.rebuildWorldBatches(effState.doc, palette, themeChanged ? null : prev?.doc ?? null);
    }

    const visibilityChanged =
      docOrThemeChanged ||
      prev.focusFloor !== effState.focusFloor ||
      prev.hideAbove !== effState.hideAbove ||
      prev.viewMode !== effState.viewMode;

    const selectionChanged =
      visibilityChanged ||
      prev.selection !== effState.selection ||
      prev.simulationIssues !== effState.simulationIssues;
    if (selectionChanged) {
      const activeSel = this.livePreviewSelection ?? effState.selection;
      this.lastLiveSelSig = this.computeSelectionSig(activeSel, this.liveBoxMode, Boolean(effBox));
      this.rebuildSelectionOverlay(effState, palette);
    }

    const nextDockKey = this.computeDockHintKey(effState, effCursor);
    if (docOrThemeChanged || nextDockKey !== this.lastDockHintKey) {
      this.lastDockHintKey = nextDockKey;
      this.rebuildDockHints(effState, palette);
    }

    this.updateRoundedGrid(effState);

    const nextPrevKey = this.computePreviewKey(effState, effCursor);
    if (docOrThemeChanged || prev?.beltPreview !== effState.beltPreview || nextPrevKey !== this.lastPreviewKey) {
      this.lastPreviewKey = nextPrevKey;
      this.rebuildPreview(effState, palette);
    }

    if (!prev || prev.boxSelectRect !== effState.boxSelectRect || prev.selectionLayerMode !== effState.selectionLayerMode || prev.focusFloor !== effState.focusFloor) {
      this.rebuildBoxSelect(effState, palette, this.liveBoxMode);
    }
    this.requestRender();
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

  private computeDirtyStationFloors(prevDoc: BlueprintDocument, nextDoc: BlueprintDocument): Set<number> {
    const dirty = new Set<number>();
    if (prevDoc.modules === nextDoc.modules) return dirty;

    const markModFloors = (m: PlacedModule) => {
      const def = getModuleDef(m.type);
      dirty.add(m.floor);
      if (!def) return;
      for (let df = 0; df < def.sizeUnits[2]; df++) dirty.add(m.floor + df);
      for (let i = 0; i < def.connectors.length; i++) dirty.add(m.floor + def.connectors[i].floorOffset);
    };

    const prevModMap = new Map<string, PlacedModule>();
    for (let i = 0; i < prevDoc.modules.length; i++) {
      prevModMap.set(prevDoc.modules[i].id, prevDoc.modules[i]);
    }
    const seenMods = new Set<string>();
    for (let i = 0; i < nextDoc.modules.length; i++) {
      const m = nextDoc.modules[i];
      seenMods.add(m.id);
      const pm = prevModMap.get(m.id);
      if (pm !== m) {
        markModFloors(m);
        if (pm) markModFloors(pm);
      }
    }
    for (let i = 0; i < prevDoc.modules.length; i++) {
      const pm = prevDoc.modules[i];
      if (!seenMods.has(pm.id)) markModFloors(pm);
    }
    return dirty;
  }

  private computeDirtyBuildingChunks(prevDoc: BlueprintDocument, nextDoc: BlueprintDocument): Set<string> {
    const dirty = new Set<string>();
    if (prevDoc.buildings === nextDoc.buildings) return dirty;

    const markBldChunks = (b: PlacedBuilding) => {
      const cx = chunkCoord(b.x);
      const cy = chunkCoord(b.y);
      dirty.add(packChunkKey(b.floor, cx, cy));
      const def = getBuildableDef(b.type);
      const [w, d] = def ? getBuildingSizeCells(def, b.rotation) : [1, 1];
      const cxMin = chunkCoord(b.x - 1);
      const cxMax = chunkCoord(b.x + w);
      const cyMin = chunkCoord(b.y - 1);
      const cyMax = chunkCoord(b.y + d);
      if (cxMin !== cx) dirty.add(packChunkKey(b.floor, cxMin, cy));
      if (cxMax !== cx) dirty.add(packChunkKey(b.floor, cxMax, cy));
      if (cyMin !== cy) dirty.add(packChunkKey(b.floor, cx, cyMin));
      if (cyMax !== cy) dirty.add(packChunkKey(b.floor, cx, cyMax));
      if (def?.kind === 'underground') {
        const reach = def.maxLength ?? 8;
        const rxMin = chunkCoord(b.x - reach);
        const rxMax = chunkCoord(b.x + reach);
        const ryMin = chunkCoord(b.y - reach);
        const ryMax = chunkCoord(b.y + reach);
        for (let gx = rxMin; gx <= rxMax; gx++) {
          for (let gy = ryMin; gy <= ryMax; gy++) {
            dirty.add(packChunkKey(b.floor, gx, gy));
          }
        }
      }
    };

    const prevBldMap = new Map<string, PlacedBuilding>();
    for (let i = 0; i < prevDoc.buildings.length; i++) {
      prevBldMap.set(prevDoc.buildings[i].id, prevDoc.buildings[i]);
    }
    const seenBlds = new Set<string>();
    for (let i = 0; i < nextDoc.buildings.length; i++) {
      const b = nextDoc.buildings[i];
      seenBlds.add(b.id);
      const pb = prevBldMap.get(b.id);
      if (pb !== b) {
        markBldChunks(b);
        if (pb) markBldChunks(pb);
      }
    }
    for (let i = 0; i < prevDoc.buildings.length; i++) {
      const pb = prevDoc.buildings[i];
      if (!seenBlds.has(pb.id)) markBldChunks(pb);
    }
    return dirty;
  }

  /**
   * Two-layer unified world batcher:
   * - Layer A (`stationFloorBuckets`): 1 compact bucket per floor for all station hulls/slabs/connectors (~25 draw calls total!)
   * - Layer B (`buildingChunkBuckets`): 128m×128m spatial chunks (~19 chunks on a 560m mega-station!) for RLE-merged
   *   belts, interior machines, underground links, and labels — giving both crisp frustum culling & ~20x faster single-chunk edits!
   */
  private rebuildWorldBatches(
    doc: BlueprintDocument,
    palette: CadThemePalette,
    prevDoc: BlueprintDocument | null = null
  ): void {
    const fullRebuild = !prevDoc || (this.stationFloorBuckets.size === 0 && this.buildingChunkBuckets.size === 0);
    const dirtyStationFloors = fullRebuild ? null : this.computeDirtyStationFloors(prevDoc, doc);
    const dirtyBldChunks = fullRebuild ? null : this.computeDirtyBuildingChunks(prevDoc, doc);

    // 1. Pre-compute station connectors & mate counts (only when modules changed or full rebuild)
    if (fullRebuild || !prevDoc || prevDoc.modules !== doc.modules) {
      const allConns: WorldConnector[] = [];
      const connCounts = new Map<string, number>();
      for (let i = 0; i < doc.modules.length; i++) {
        const mod = doc.modules[i];
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
    }

    const connCounts = this.cachedConnCounts;
    const idx = getDocSpatialIndex(doc);

    if (fullRebuild) {
      this.clearWorldBuckets();
    } else {
      if (dirtyStationFloors && dirtyStationFloors.size > 0) {
        for (const f of dirtyStationFloors) {
          const existing = this.stationFloorBuckets.get(f);
          if (existing) {
            this.worldGroup.remove(existing.root);
            existing.dispose();
            this.stationFloorBuckets.delete(f);
          }
        }
      }
      if (dirtyBldChunks && dirtyBldChunks.size > 0) {
        for (const ck of dirtyBldChunks) {
          const existing = this.buildingChunkBuckets.get(ck);
          if (existing) {
            this.worldGroup.remove(existing.root);
            existing.dispose();
            this.buildingChunkBuckets.delete(ck);
          }
        }
      }
    }

    const needStationBuild = fullRebuild || (dirtyStationFloors !== null && dirtyStationFloors.size > 0);
    const needBuildingBuild = fullRebuild || (dirtyBldChunks !== null && dirtyBldChunks.size > 0);
    if (!needStationBuild && !needBuildingBuild) return;

    const touchedStationFloors = new Set<number>();
    const touchedBldChunks = new Set<string>();

    // Collect geometry in deferred-line mode (ZERO throwaway LineSegmentsGeometry/LineMaterial!)
    withDeferredLines(() => {
      // Layer A: Per-floor station modules
      if (needStationBuild) {
        const onTouchStation = (bucket: RenderChunkBucket) => {
          touchedStationFloors.add(bucket.floor);
        };
        for (let i = 0; i < doc.modules.length; i++) {
          const mod = doc.modules[i];
          const def = getModuleDef(mod.type);
          if (!def) continue;
          this.ingestStationModule(mod, def, palette, connCounts, dirtyStationFloors, onTouchStation);
        }
      }

      // Layer B: 128m×128m spatial chunks for interior buildings & RLE-merged belts
      if (needBuildingBuild) {
        const dirtyBldFloors = dirtyBldChunks ? new Set<number>() : null;
        if (dirtyBldChunks && dirtyBldFloors) {
          for (const ck of dirtyBldChunks) {
            dirtyBldFloors.add(Number(ck.slice(0, ck.indexOf(':'))));
          }
        }
        const floorsIter = dirtyBldFloors ? dirtyBldFloors : idx.buildingsByFloor.keys();
        for (const floor of floorsIter) {
          const floorBlds = idx.buildingsByFloor.get(floor);
          if (!floorBlds || floorBlds.length === 0) continue;
          const floorCellMap = idx.buildingCellByFloor.get(floor);
          const baseY = floor * FLOOR_VISUAL_SPACING;

          const beltsByChunk = new Map<string, { cx: number; cy: number; list: PlacedBuilding[] }>();
          const machinesByChunk = new Map<string, { cx: number; cy: number; list: PlacedBuilding[] }>();

          for (let i = 0; i < floorBlds.length; i++) {
            const b = floorBlds[i];
            const cx = chunkCoord(b.x);
            const cy = chunkCoord(b.y);
            const ck = packChunkKey(floor, cx, cy);
            if (dirtyBldChunks && !dirtyBldChunks.has(ck)) continue;
            const def = getBuildableDef(b.type);
            if (!def) continue;
            if (def.kind === 'belt') {
              let group = beltsByChunk.get(ck);
              if (!group) {
                group = { cx, cy, list: [] };
                beltsByChunk.set(ck, group);
              }
              group.list.push(b);
            } else {
              let group = machinesByChunk.get(ck);
              if (!group) {
                group = { cx, cy, list: [] };
                machinesByChunk.set(ck, group);
              }
              group.list.push(b);
            }
          }

          for (const group of beltsByChunk.values()) {
            const bucket = this.getOrCreateBuildingChunkBucket(floor, group.cx, group.cy);
            touchedBldChunks.add(bucket.chunkKey);
            const beltBedTris: number[] = [];
            const beltRailsMk1: number[] = [];
            const beltRailsMk2: number[] = [];
            const beltRailsMk3: number[] = [];
            const beltChevs: number[] = [];
            emitBeltsMergedToBuffers(
              doc,
              group.list,
              floorCellMap,
              beltBedTris,
              beltRailsMk1,
              beltRailsMk2,
              beltRailsMk3,
              beltChevs
            );
            if (beltBedTris.length >= 9) {
              bucket.addRawTriangles(beltBedTris, 'flat', 'always', palette.beltTrackFill, 0.96, false, false);
            }
            if (beltRailsMk1.length >= 6) {
              bucket.addLineSegments(beltRailsMk1, 'flat', 'always', { color: palette.beltRailMk1, alphaScale: 1.0, widthPx: 1.05, lodTier: 'detail' });
            }
            if (beltRailsMk2.length >= 6) {
              bucket.addLineSegments(beltRailsMk2, 'flat', 'always', { color: palette.beltRailMk2, alphaScale: 1.0, widthPx: 1.05, lodTier: 'detail' });
            }
            if (beltRailsMk3.length >= 6) {
              bucket.addLineSegments(beltRailsMk3, 'flat', 'always', { color: palette.beltRailMk3, alphaScale: 1.0, widthPx: 1.05, lodTier: 'detail' });
            }
            if (beltChevs.length >= 6) {
              bucket.addLineSegments(beltChevs, 'flat', 'always', { color: palette.beltArrow, alphaScale: 1.0, widthPx: 0.9, lodTier: 'micro' });
            }
          }

          for (const group of machinesByChunk.values()) {
            const bucket = this.getOrCreateBuildingChunkBucket(floor, group.cx, group.cy);
            touchedBldChunks.add(bucket.chunkKey);
            for (let i = 0; i < group.list.length; i++) {
              const b = group.list[i];
              const def = getBuildableDef(b.type);
              if (!def) continue;
              const { root, extrudeGroup, roofHeight } = buildMachineLineArt(b, def, baseY, 1.0, false, palette);
              bucket.ingestObject(root, extrudeGroup, 'always');

              const recipe = b.recipeId ? getRecipeDef(b.recipeId) : null;
              const firstFilter = b.filterItems && b.filterItems.length > 0 ? getItemNameZh(b.filterItems[0]) : null;
              const caption = b.label || recipe?.nameZh || firstFilter || null;
              const [w, d] = getBuildingSizeCells(def, b.rotation);
              if (caption && (Math.min(w, d) >= 2 || def.kind === 'sign')) {
                const [cxM, czM] = getBuildingCenterM(b, def);
                const tex = getLabelTexture(caption, null, palette, this.maxAniso);
                this.queueTextureWarmup(tex);
                const labelW = def.kind === 'sign' ? 1.4 : Math.min(w - 0.35, 3.8);
                bucket.addLabel('building', tex, labelW, cxM, czM, 0.09, roofHeight, 0.94);
              }
            }
          }
        }
      }
    });

    // 4. Batch underground belt dashed links into their building spatial chunk
    if (needBuildingBuild) {
      for (const link of computeUndergroundLinks(doc)) {
        const lcx = chunkCoord((link.x1 + link.x2) * 0.5);
        const lcy = chunkCoord((link.y1 + link.y2) * 0.5);
        const ck = packChunkKey(link.floor, lcx, lcy);
        if (dirtyBldChunks && !dirtyBldChunks.has(ck)) continue;
        const bucket = this.getOrCreateBuildingChunkBucket(link.floor, lcx, lcy);
        touchedBldChunks.add(bucket.chunkKey);
        bucket.addLineSegments([link.x1, 0.05, link.y1, link.x2, 0.05, link.y2], 'flat', 'always', {
          color: palette.undergroundLink,
          alphaScale: 0.8,
          widthPx: 1.1,
          lodTier: 'detail',
          dashed: true,
          dashSize: 0.32,
          gapSize: 0.28,
        });
      }
    }

    // 5. Finalize ONLY newly built station floors & building chunks, and queue silent GPU VBO pre-warm
    for (const f of touchedStationFloors) {
      const bucket = this.stationFloorBuckets.get(f);
      if (bucket) {
        bucket.finalize();
        if (!bucket.isEmpty) this.pendingWarmupBuckets.push(bucket);
      }
    }
    for (const ck of touchedBldChunks) {
      const bucket = this.buildingChunkBuckets.get(ck);
      if (bucket) {
        bucket.finalize();
        if (!bucket.isEmpty) this.pendingWarmupBuckets.push(bucket);
      }
    }
  }

  private ingestStationModule(
    mod: PlacedModule,
    def: StationModuleDef,
    palette: CadThemePalette,
    connCounts: Map<string, number>,
    allowedFloors: Set<number> | null,
    onTouch: (bucket: RenderChunkBucket) => void
  ): void {
    const [cx, cy] = getModuleCenterM(mod, def);
    const baseAllowed = !allowedFloors || allowedFloors.has(mod.floor);
    const bucket = baseAllowed ? this.getOrCreateStationFloorBucket(mod.floor) : null;
    if (bucket) onTouch(bucket);

    const [wu, du, hu] = getModuleSizeUnits(def, mod.rotation);
    const wM = wu * STATION_UNIT_M;
    const dM = du * STATION_UNIT_M;
    const baseY = mod.floor * FLOOR_VISUAL_SPACING;
    const rotY = -mod.rotation * (Math.PI / 2);

    let labelRoofHeight = 0.02;

    if (!def.hasFactoryFloor) {
      if (bucket) {
        const art = buildStationModuleArt(mod, def, baseY, 1.0, false, palette);
        labelRoofHeight = art.roofHeight;
        bucket.ingestObject(art.root, art.extrudeGroup, 'always');
      }
    } else {
      if (bucket) {
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
      }

      // Floor surface(s) placed into their respective station floor bucket (only if dirty)!
      for (const surf of def.floors) {
        const surfFloor = mod.floor + surf.floorOffset;
        if (allowedFloors && !allowedFloors.has(surfFloor)) continue;
        const surfBucket = this.getOrCreateStationFloorBucket(surfFloor);
        onTouch(surfBucket);
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
      if (bucket && hu > 1) {
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

    // Connectors placed into their respective station floor bucket (order-independent mated seam deduplication!)
    for (const c of getModuleWorldConnectors(mod, def)) {
      if (allowedFloors && !allowedFloors.has(c.floor)) continue;
      const cBucket = this.getOrCreateStationFloorBucket(c.floor);
      onTouch(cBucket);
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
        // Order-independent deduplication: draw shared mated seam tick only on E (0) or S (1) side!
        if (isMated && (c.rotation === 2 || c.rotation === 3)) continue;
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

    if (!bucket) return;

    // Station Overview caption label
    const shortName = getShortLabel(def.id, def.nameZh);
    const tex = getLabelTexture(shortName, mod.label || null, palette, this.maxAniso);
    this.queueTextureWarmup(tex);
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
   * Ultra-fast O(|selected|) Shapez 2 selection highlight overlay (never rebuilds world batches!).
   * Renders BOTH crisp perimeter outlines AND merged luminous translucent top pads so every
   * entity being selected (or targeted for Shift area-demolish) glows unmistakably in real time.
   */
  private rebuildSelectionOverlay(state: SceneRenderState, palette: CadThemePalette): void {
    this.clearGroup(this.selectionGroup);
    const activeSel = this.livePreviewSelection ?? state.selection;
    const isDemolishPreview = Boolean(this.liveBoxRect && this.liveBoxMode === 'demolish');
    const highlightColor = isDemolishPreview ? palette.invalidGhost : palette.selectOutline;
    const hasSelection = activeSel.moduleIds.length > 0 || activeSel.buildingIds.length > 0;
    const simIssues = state.simulationIssues ?? [];
    if (!hasSelection && simIssues.length === 0) return;

    const pts: number[] = [];
    const fillTris: number[] = [];

    if (activeSel.moduleIds.length > 0) {
      const modById = getModuleSpatialIndex(state.doc.modules).moduleById;
      for (let i = 0; i < activeSel.moduleIds.length; i++) {
        const mod = modById.get(activeSel.moduleIds[i]);
        if (!mod) continue;
        const def = getModuleDef(mod.type);
        if (!def) continue;
        const op = this.layerOpacityFor(mod.floor, state.focusFloor, state.hideAbove);
        if (op <= 0.01) continue;
        const [x0, z0, x1, z1] = getModuleBoundsM(mod, def);
        const y = mod.floor * FLOOR_VISUAL_SPACING + 0.11;
        const yf = y - 0.012;
        const pad = 0.08;
        const fx0 = x0 + pad;
        const fz0 = z0 + pad;
        const fx1 = x1 - pad;
        const fz1 = z1 - pad;
        fillTris.push(
          fx0, yf, fz0, fx0, yf, fz1, fx1, yf, fz1,
          fx0, yf, fz0, fx1, yf, fz1, fx1, yf, fz0
        );
        pts.push(
          fx0, y, fz0, fx1, y, fz0,
          fx1, y, fz0, fx1, y, fz1,
          fx1, y, fz1, fx0, y, fz1,
          fx0, y, fz1, fx0, y, fz0
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
    }

    if (activeSel.buildingIds.length > 0) {
      const bldById = getBuildingSpatialIndex(state.doc.buildings).buildingById;
      for (let i = 0; i < activeSel.buildingIds.length; i++) {
        const b = bldById.get(activeSel.buildingIds[i]);
        if (!b) continue;
        const def = getBuildableDef(b.type);
        if (!def) continue;
        const op = this.layerOpacityFor(b.floor, state.focusFloor, state.hideAbove);
        if (op <= 0.01) continue;
        const [w, d] = getBuildingSizeCells(def, b.rotation);
        const y = b.floor * FLOOR_VISUAL_SPACING + 0.125;
        const yf = y - 0.012;
        const x0 = b.x + 0.04;
        const z0 = b.y + 0.04;
        const x1 = b.x + w - 0.04;
        const z1 = b.y + d - 0.04;
        fillTris.push(
          x0, yf, z0, x0, yf, z1, x1, yf, z1,
          x0, yf, z0, x1, yf, z1, x1, yf, z0
        );
        pts.push(
          x0, y, z0, x1, y, z0,
          x1, y, z0, x1, y, z1,
          x1, y, z1, x0, y, z1,
          x0, y, z1, x0, y, z0
        );
      }
    }

    if (fillTris.length >= 9) {
      const fillGeo = new THREE.BufferGeometry();
      fillGeo.setAttribute('position', new THREE.Float32BufferAttribute(fillTris, 3));
      const fillMat = new THREE.MeshBasicMaterial({
        color: highlightColor,
        transparent: true,
        opacity: isDemolishPreview ? 0.24 : palette.isLight ? 0.18 : 0.15,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      this.selectionGroup.add(new THREE.Mesh(fillGeo, fillMat));
    }

    if (pts.length >= 6) {
      this.selectionGroup.add(
        createCrispLineSegments(pts, {
          color: highlightColor,
          opacity: 1.0,
          widthPx: isDemolishPreview ? 1.9 : 1.75,
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
        if (issue.active) {
          const ax0 = issue.x - 0.08;
          const az0 = issue.y - 0.08;
          const ax1 = issue.x + 1.08;
          const az1 = issue.y + 1.08;
          const targetPts = issue.severity === 'error' ? errPts : inputWarnPts;
          targetPts.push(
            ax0, y + 0.03, az0, ax1, y + 0.03, az0,
            ax1, y + 0.03, az0, ax1, y + 0.03, az1,
            ax1, y + 0.03, az1, ax0, y + 0.03, az1,
            ax0, y + 0.03, az1, ax0, y + 0.03, az0
          );
        }
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
          // Crisp amber-yellow outer frame + inner diamond pip marking every raw-material HEAD (首)!
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
        } else if (issue.code === 'blueprint-output') {
          // Crisp amber-yellow outer frame + nested inner square marking every blueprint output TAIL (尾)!
          const ix0 = issue.x + 0.27;
          const iz0 = issue.y + 0.27;
          const ix1 = issue.x + 0.73;
          const iz1 = issue.y + 0.73;
          inputWarnPts.push(
            x0, y, z0, x1, y, z0,
            x1, y, z0, x1, y, z1,
            x1, y, z1, x0, y, z1,
            x0, y, z1, x0, y, z0,
            ix0, y, iz0, ix1, y, iz0,
            ix1, y, iz0, ix1, y, iz1,
            ix1, y, iz1, ix0, y, iz1,
            ix0, y, iz1, ix0, y, iz0
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

    // Collect candidate ghost modules (identical connector-matching pipeline for single module & blueprint paste)
    const ghostModules: PlacedModule[] = [];
    const heldTypes = new Set<string>();
    const relevantFloors = new Set<number>([state.focusFloor]);

    if (tool.kind === 'place-module') {
      const def = getModuleDef(tool.moduleType);
      if (!def) return;
      for (const c of def.connectors) heldTypes.add(c.type);
      if (state.cursorWorld) {
        const gx = Math.floor(state.cursorWorld.x / STATION_UNIT_M);
        const gy = Math.floor(state.cursorWorld.y / STATION_UNIT_M);
        ghostModules.push({
          id: '__ghost_mod',
          type: def.id,
          gx,
          gy,
          floor: state.focusFloor,
          rotation: tool.rotation,
        });
      }
    } else if (tool.kind === 'stamp-blueprint') {
      const anchorFloor = state.focusFloor + tool.floorOffset;
      if (state.cursorWorld) {
        const shiftGx = Math.floor(Math.floor(state.cursorWorld.x) / STATION_UNIT_M);
        const shiftGy = Math.floor(Math.floor(state.cursorWorld.y) / STATION_UNIT_M);
        for (let i = 0; i < tool.blueprint.modules.length; i++) {
          const m = tool.blueprint.modules[i];
          ghostModules.push({
            ...m,
            id: `__ghost_stamp_${i}`,
            gx: m.gx + shiftGx,
            gy: m.gy + shiftGy,
            floor: m.floor + anchorFloor,
          });
        }
      } else {
        for (const c of collectOpenGhostConnectors(tool.blueprint.modules)) {
          heldTypes.add(c.type);
        }
      }
    }

    // Only open boundary connectors of the ghost (excluding seams internally mated inside a stamp blueprint)
    const ghostConns = collectOpenGhostConnectors(ghostModules);
    const ghostByKey = new Map<string, WorldConnector[]>();
    for (const gc of ghostConns) {
      heldTypes.add(gc.type);
      relevantFloors.add(gc.floor);
      const k = getWorldConnectorKey(gc);
      const list = ghostByKey.get(k);
      if (list) list.push(gc);
      else ghostByKey.set(k, [gc]);
    }

    const matchSealsPts: number[] = [];
    const vertFocusPts: number[] = [];
    const vertAdjPts: number[] = [];
    const xlMatchPts: number[] = [];
    const largeMatchPts: number[] = [];
    const dimHintPts: number[] = [];

    for (const c of this.cachedAllConnectors) {
      const isVertical = c.type.startsWith('Vertical');
      const key = getWorldConnectorKey(c);
      if (!isVertical && (this.cachedConnCounts.get(key) ?? 0) >= 2) continue; // Already mated

      // Check whether hovered ghost (single module or blueprint stamp) docks flush onto this open socket!
      const matchingGhosts = ghostByKey.get(key);
      const isLockedNow =
        matchingGhosts?.some((gc) => areWorldConnectorsMated(c, gc)) ?? false;

      if (!isLockedNow) {
        // Show open horizontal sockets on relevant floors; show vertical sockets on focusFloor or adjacent floors
        if (!isVertical && !relevantFloors.has(c.floor)) continue;
        if (isVertical && !relevantFloors.has(c.floor) && Math.abs(c.floor - state.focusFloor) > 1) continue;
      }

      const compatible = heldTypes.size === 0 || heldTypes.has(c.type);
      const cyWorld = c.floor * FLOOR_VISUAL_SPACING + 0.13;

      if (isVertical) {
        if (isLockedNow) {
          const rOuter = c.type === 'Vertical2x2' ? 4.0 : 2.35;
          const rInner = rOuter * 0.62;
          for (const r of [rOuter, rInner]) {
            matchSealsPts.push(
              c.x, cyWorld + 0.04, c.y - r, c.x + r, cyWorld + 0.04, c.y,
              c.x + r, cyWorld + 0.04, c.y, c.x, cyWorld + 0.04, c.y + r,
              c.x, cyWorld + 0.04, c.y + r, c.x - r, cyWorld + 0.04, c.y,
              c.x - r, cyWorld + 0.04, c.y, c.x, cyWorld + 0.04, c.y - r
            );
          }
          continue;
        }
        if (!compatible) continue;
        const r = c.type === 'Vertical2x2' ? 3.7 : 2.1;
        const dst = c.floor === state.focusFloor ? vertFocusPts : vertAdjPts;
        dst.push(
          c.x, cyWorld, c.y - r, c.x + r, cyWorld, c.y,
          c.x + r, cyWorld, c.y, c.x, cyWorld, c.y + r,
          c.x, cyWorld, c.y + r, c.x - r, cyWorld, c.y,
          c.x - r, cyWorld, c.y, c.x, cyWorld, c.y - r
        );
        continue;
      }

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
      if (compatible) {
        pushStationConnectorMarkPts(isXL ? xlMatchPts : largeMatchPts, c.x, cyWorld, c.y, c.rotation, span, 'hint-match');
      } else {
        pushStationConnectorMarkPts(dimHintPts, c.x, cyWorld, c.y, c.rotation, span, 'hint-dim');
      }
    }

    if (vertFocusPts.length >= 6) {
      this.dockHintsGroup.add(createCrispLineSegments(vertFocusPts, { color: palette.connVertical, opacity: 0.95, widthPx: 1.5 }));
    }
    if (vertAdjPts.length >= 6) {
      this.dockHintsGroup.add(createCrispLineSegments(vertAdjPts, { color: palette.connVertical, opacity: 0.45, widthPx: 1.5 }));
    }
    if (xlMatchPts.length >= 6) {
      this.dockHintsGroup.add(createCrispLineSegments(xlMatchPts, { color: palette.connXLarge, opacity: 0.92, widthPx: 1.45 }));
    }
    if (largeMatchPts.length >= 6) {
      this.dockHintsGroup.add(createCrispLineSegments(largeMatchPts, { color: palette.validGhost, opacity: 0.92, widthPx: 1.45 }));
    }
    if (dimHintPts.length >= 6) {
      this.dockHintsGroup.add(createCrispLineSegments(dimHintPts, { color: palette.connLarge, opacity: 0.32, widthPx: 1.08 }));
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
    const ghostPts: number[] = [];
    const xlPts: number[] = [];
    for (const c of getModuleWorldConnectors(mod, def)) {
      const cyWorld = c.floor * FLOOR_VISUAL_SPACING + 0.1;
      if (c.type.startsWith('Vertical')) {
        const r = c.type === 'Vertical2x2' ? 3.2 : 1.7;
        ghostPts.push(
          c.x, cyWorld, c.y - r, c.x + r, cyWorld, c.y,
          c.x + r, cyWorld, c.y, c.x, cyWorld, c.y + r,
          c.x, cyWorld, c.y + r, c.x - r, cyWorld, c.y,
          c.x - r, cyWorld, c.y, c.x, cyWorld, c.y - r
        );
      } else {
        const isXL = c.type === 'XLarge';
        const span = isXL ? 18 : 5.2;
        pushStationConnectorMarkPts(isXL ? xlPts : ghostPts, c.x, cyWorld, c.y, c.rotation, span, 'ghost');
      }
    }
    if (ghostPts.length >= 6) {
      target.add(createCrispLineSegments(ghostPts, { color: ghostColor, opacity: 0.96, widthPx: 1.4 }));
    }
    if (xlPts.length >= 6) {
      target.add(createCrispLineSegments(xlPts, { color: palette.connXLarge, opacity: 0.96, widthPx: 1.4 }));
    }
  }

  private getCurrentExtrusionScale(): number {
    const pitchDeg = THREE.MathUtils.radToDeg(this.rig.currentPitchRad);
    const t = THREE.MathUtils.clamp((86.5 - pitchDeg) / (86.5 - 77.0), 0, 1);
    const smooth = t * t * (3 - 2 * t);
    return 0.008 + smooth * 0.992;
  }

  private computeDistanceLod(dist = this.rig.currentDistance): number {
    // Full crisp detail up to 58m; smoothly fades to 0 by 190m so sub-pixel belt rails & 1x1 interior
    // wireframes stop shading on distant chunks & macro overview orbits!
    return THREE.MathUtils.clamp(1.0 - (dist - 58) / 132, 0.0, 1.0);
  }

  private computeMicroLod(dist = this.rig.currentDistance): number {
    // Full crisp belt chevrons up to 28m; cleanly culled to 0 past 58m (skips 155,000+ micro quads!)
    return THREE.MathUtils.clamp(1.0 - (dist - 28) / 30, 0.0, 1.0);
  }

  private computeBuildingPrimaryLod(dist = this.rig.currentDistance): number {
    // Keep 100% crisp machine outlines up to 135m; fade smoothly to 0 by 230m so far horizon chunks &
    // macro mega-station overviews render clean solid belt highways + machine blocks without SDF overdraw!
    return THREE.MathUtils.clamp(1.0 - (dist - 135) / 95, 0.0, 1.0);
  }

  /**
   * Unified per-render-frame spatial frustum culling + per-chunk 3D Euclidean camera-distance LOD!
   * - Layer A (`stationFloorBuckets`): ~5 per-floor buckets (always razor-sharp station skeleton!)
   * - Layer B (`buildingChunkBuckets`): 96m×96m frustum-culled interior chunks with per-chunk 3D distance LOD
   *   so even grazing low-angle (22°) orbits in Building View keep foreground crisp and shed horizon clutter!
   */
  private cullAndSyncVisibleChunks(): void {
    const state = this.lastState;
    if (!state) return;

    const cam = this.rig.camera;
    cam.updateMatrixWorld();
    _projScreenMat.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreenMat);

    const camPos = cam.position;
    const dist = this.rig.currentDistance;
    const stDetailLod = this.computeDistanceLod(dist);
    const stMicroLod = this.computeMicroLod(dist);
    const yScale = this.getCurrentExtrusionScale();

    // Layer A: Compact per-floor station hulls, floors, docks, solar arrays, connectors (~25 draw calls total)
    for (const bucket of this.stationFloorBuckets.values()) {
      if (bucket.isEmpty) {
        bucket.root.visible = false;
        continue;
      }
      const floorOp = this.layerOpacityFor(bucket.floor, state.focusFloor, state.hideAbove);
      if (floorOp <= 0.01 || !_frustum.intersectsBox(bucket.worldBounds)) {
        bucket.root.visible = false;
        continue;
      }
      bucket.root.visible = true;
      bucket.syncVisuals(floorOp, state.viewMode, stDetailLod, stMicroLod, yScale, dist, 1.0, true);
    }

    // Layer B: 96m×96m spatial chunks with true 3D per-chunk camera distance LOD
    for (const bucket of this.buildingChunkBuckets.values()) {
      if (bucket.isEmpty) {
        bucket.root.visible = false;
        continue;
      }
      const isFocus = bucket.floor === state.focusFloor;
      // Non-focus reference floors only show clean flat interior footprints when zoomed in (<= 60m);
      // above 60m their translucent station skeleton is already crystal clear with zero alpha-blended clutter!
      if (!isFocus && dist > 60) {
        bucket.root.visible = false;
        continue;
      }
      const floorOp = this.layerOpacityFor(bucket.floor, state.focusFloor, state.hideAbove);
      if (floorOp <= 0.01 || !_frustum.intersectsBox(bucket.worldBounds)) {
        bucket.root.visible = false;
        continue;
      }
      bucket.root.visible = true;
      if (!isFocus) {
        // Flat translucent blueprint reference on non-focus floors (zero 3D wall overdraw & zero SDF lines!)
        bucket.syncVisuals(floorOp, state.viewMode, 0.0, 0.0, yScale, 999, 0.0, false);
        continue;
      }
      // Exact 3D Euclidean distance from camera eye to chunk AABB prevents low-angle (22°) horizon explosions!
      const chunkDist = bucket.worldBounds.distanceToPoint(camPos);
      bucket.syncVisuals(
        floorOp,
        state.viewMode,
        this.computeDistanceLod(chunkDist),
        this.computeMicroLod(chunkDist),
        yScale,
        chunkDist,
        this.computeBuildingPrimaryLod(chunkDist),
        true
      );
    }

    if (Math.abs(yScale - this.lastExtrusionScale) > 1e-4) {
      this.lastExtrusionScale = yScale;
      for (let i = 0; i < this.ghostExtrudeTargets.length; i++) {
        this.ghostExtrudeTargets[i].scale.y = yScale;
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
    const mesh = this.roundedGrid.mesh;
    const gridY = state.focusFloor * FLOOR_VISUAL_SPACING + 0.018;

    const isStation = state.viewMode === 'station';
    const cellSize = isStation ? STATION_UNIT_M : 1.0;
    const cursorRadius = isStation ? 44.0 : 6.8;
    u.uCellSize.value = cellSize;
    u.uCursorRadius.value = cursorRadius;
    u.uCornerRadius.value = isStation ? 0.06 : 0.14;

    if (this.cameraDragging) {
      u.uCursorActive.value = 0.0;
      u.uHasFocusRect.value = 0.0;
      mesh.visible = false;
      return;
    }

    const showForTool =
      state.activeTool.kind !== 'select' || state.boxSelectRect !== null || state.beltPreview.length > 0;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;

    if (state.cursorWorld) {
      u.uCursorWorld.value.set(state.cursorWorld.x, state.cursorWorld.y);
      u.uCursorActive.value = 1.0;
      u.uOpacity.value = showForTool ? 0.64 : isStation ? 0.3 : 0.42;
      const rPad = cursorRadius * 1.08;
      minX = state.cursorWorld.x - rPad;
      maxX = state.cursorWorld.x + rPad;
      minZ = state.cursorWorld.y - rPad;
      maxZ = state.cursorWorld.y + rPad;
    } else {
      u.uCursorActive.value = 0.0;
    }

    let hasRect = false;
    let rMinX = 0;
    let rMinZ = 0;
    let rMaxX = 0;
    let rMaxZ = 0;

    if (state.boxSelectRect) {
      rMinX = state.boxSelectRect.minX;
      rMinZ = state.boxSelectRect.minY;
      rMaxX = state.boxSelectRect.maxX;
      rMaxZ = state.boxSelectRect.maxY;
      hasRect = true;
    } else if (state.beltPreview.length > 0) {
      rMinX = Infinity;
      rMinZ = Infinity;
      rMaxX = -Infinity;
      rMaxZ = -Infinity;
      for (let i = 0; i < state.beltPreview.length; i++) {
        const s = state.beltPreview[i];
        if (s.x < rMinX) rMinX = s.x;
        if (s.y < rMinZ) rMinZ = s.y;
        if (s.x + 1 > rMaxX) rMaxX = s.x + 1;
        if (s.y + 1 > rMaxZ) rMaxZ = s.y + 1;
      }
      hasRect = true;
    } else if (state.cursorWorld && state.activeTool.kind === 'place-building') {
      const def = getBuildableDef(state.activeTool.buildingType);
      if (def) {
        const [w, d] = getBuildingSizeCells(def, state.activeTool.rotation);
        const bx = Math.floor(state.cursorWorld.x - w / 2 + 0.5);
        const by = Math.floor(state.cursorWorld.y - d / 2 + 0.5);
        rMinX = bx;
        rMinZ = by;
        rMaxX = bx + w;
        rMaxZ = by + d;
        hasRect = true;
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
      rMinX = ax;
      rMinZ = ay;
      rMaxX = ax + bounds.width;
      rMaxZ = ay + bounds.depth;
      hasRect = true;
    }

    if (hasRect) {
      u.uFocusRect.value.set(rMinX, rMinZ, rMaxX, rMaxZ);
      u.uHasFocusRect.value = 1.0;
      const rectPad = cellSize * 2.8;
      if (rMinX - rectPad < minX) minX = rMinX - rectPad;
      if (rMaxX + rectPad > maxX) maxX = rMaxX + rectPad;
      if (rMinZ - rectPad < minZ) minZ = rMinZ - rectPad;
      if (rMaxZ + rectPad > maxZ) maxZ = rMaxZ + rectPad;
    } else {
      u.uHasFocusRect.value = 0.0;
    }

    if (!Number.isFinite(minX)) {
      mesh.visible = false;
      return;
    }
    mesh.visible = true;
    mesh.position.set((minX + maxX) * 0.5, gridY, (minZ + maxZ) * 0.5);
    mesh.scale.set(Math.max(1, maxX - minX), 1, Math.max(1, maxZ - minZ));
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
      const ugType = getMatchingUndergroundType(beltType) ?? beltType;
      const baseY = state.focusFloor * FLOOR_VISUAL_SPACING + 0.07;
      const pairEndpoints = new Map<number, { inSeg?: BeltCellSpec; outSeg?: BeltCellSpec; valid: boolean }>();

      // Batched geometry accumulators (reduces 200+ LineSegments2 draw calls per cursor cell to ~4!)
      const validBeltBoxPts: number[] = [];
      const invalidBeltBoxPts: number[] = [];
      const validChevPts: number[] = [];
      const invalidChevPts: number[] = [];
      const validUgFramePts: number[] = [];
      const invalidUgFramePts: number[] = [];
      const validUgPadTris: number[] = [];
      const invalidUgPadTris: number[] = [];
      const validDashPts: number[] = [];
      const invalidDashPts: number[] = [];
      const waypointPts: number[] = [];

      for (let i = 0; i < state.beltPreview.length; i++) {
        const seg = state.beltPreview[i];
        const isUg = seg.kind === 'underground-in' || seg.kind === 'underground-out';
        const issue = validateBuildingPlacement(
          state.doc,
          { type: isUg ? ugType : beltType, x: seg.x, y: seg.y, floor: state.focusFloor, rotation: seg.rotation },
          { allowBeltReplace: true }
        );
        const isBad = Boolean(issue);
        if (isUg) {
          const frameDst = isBad ? invalidUgFramePts : validUgFramePts;
          pushFlatRectPts(frameDst, seg.x + 0.06, seg.y + 0.06, seg.x + 0.94, seg.y + 0.94, baseY + 0.02);
          pushFlatRectPts(frameDst, seg.x + 0.2, seg.y + 0.2, seg.x + 0.8, seg.y + 0.8, baseY + 0.02);
          const padDst = isBad ? invalidUgPadTris : validUgPadTris;
          const px0 = seg.x + 0.08;
          const pz0 = seg.y + 0.08;
          const px1 = seg.x + 0.92;
          const pz1 = seg.y + 0.92;
          const py = baseY + 0.01;
          padDst.push(
            px0, py, pz0, px0, py, pz1, px1, py, pz1,
            px0, py, pz0, px1, py, pz1, px1, py, pz0
          );
          pushRotatedChevronPts(isBad ? invalidChevPts : validChevPts, seg.x + 0.5, baseY + 0.03, seg.y + 0.5, 0.32, seg.rotation);

          if (seg.pairIndex !== undefined) {
            const p = pairEndpoints.get(seg.pairIndex) ?? { valid: true };
            if (seg.kind === 'underground-in') p.inSeg = seg;
            else p.outSeg = seg;
            if (issue) p.valid = false;
            pairEndpoints.set(seg.pairIndex, p);
          } else if (seg.kind === 'underground-in') {
            const dx = seg.rotation === 0 ? 1 : seg.rotation === 2 ? -1 : 0;
            const dy = seg.rotation === 1 ? 1 : seg.rotation === 3 ? -1 : 0;
            const dashDst = isBad ? invalidDashPts : validDashPts;
            dashDst.push(
              seg.x + 0.5, baseY + 0.04, seg.y + 0.5,
              seg.x + 0.5 + dx * 8, baseY + 0.04, seg.y + 0.5 + dy * 8
            );
          }
        } else {
          pushFlatRectPts(isBad ? invalidBeltBoxPts : validBeltBoxPts, seg.x + 0.14, seg.y + 0.14, seg.x + 0.86, seg.y + 0.86, baseY);
          pushRotatedChevronPts(isBad ? invalidChevPts : validChevPts, seg.x + 0.5, baseY + 0.01, seg.y + 0.5, 0.28, seg.rotation);
        }

        if (seg.isWaypoint) {
          const cx = seg.x + 0.5;
          const cz = seg.y + 0.5;
          const r = 0.44;
          const wy = baseY + 0.045;
          waypointPts.push(
            cx, wy, cz - r, cx + r, wy, cz,
            cx + r, wy, cz, cx, wy, cz + r,
            cx, wy, cz + r, cx - r, wy, cz,
            cx - r, wy, cz, cx, wy, cz - r
          );
        }
      }

      for (const pair of pairEndpoints.values()) {
        if (!pair.inSeg || !pair.outSeg) continue;
        const dashDst = pair.valid ? validDashPts : invalidDashPts;
        dashDst.push(
          pair.inSeg.x + 0.5, baseY + 0.04, pair.inSeg.y + 0.5,
          pair.outSeg.x + 0.5, baseY + 0.04, pair.outSeg.y + 0.5
        );
      }

      const emitMergedPads = (tris: number[], color: number) => {
        if (tris.length < 9) return;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(tris, 3));
        const mat = new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.22,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        this.previewGroup.add(new THREE.Mesh(geo, mat));
      };

      emitMergedPads(validUgPadTris, palette.validGhost);
      emitMergedPads(invalidUgPadTris, palette.invalidGhost);

      if (validBeltBoxPts.length >= 6) {
        this.previewGroup.add(createCrispLineSegments(validBeltBoxPts, { color: palette.validGhost, opacity: 0.6, widthPx: 1.3 }));
      }
      if (invalidBeltBoxPts.length >= 6) {
        this.previewGroup.add(createCrispLineSegments(invalidBeltBoxPts, { color: palette.invalidGhost, opacity: 0.6, widthPx: 1.3 }));
      }
      if (validUgFramePts.length >= 6) {
        this.previewGroup.add(createCrispLineSegments(validUgFramePts, { color: palette.validGhost, opacity: 0.92, widthPx: 1.3 }));
      }
      if (invalidUgFramePts.length >= 6) {
        this.previewGroup.add(createCrispLineSegments(invalidUgFramePts, { color: palette.invalidGhost, opacity: 0.92, widthPx: 1.3 }));
      }
      if (validChevPts.length >= 6) {
        this.previewGroup.add(createCrispLineSegments(validChevPts, { color: palette.validGhost, opacity: 0.96, widthPx: 1.25 }));
      }
      if (invalidChevPts.length >= 6) {
        this.previewGroup.add(createCrispLineSegments(invalidChevPts, { color: palette.invalidGhost, opacity: 0.96, widthPx: 1.25 }));
      }
      if (validDashPts.length >= 6) {
        this.previewGroup.add(
          createCrispLineSegments(validDashPts, { color: palette.validGhost, opacity: 0.92, widthPx: 1.65, dashed: true, dashSize: 0.34, gapSize: 0.22 })
        );
      }
      if (invalidDashPts.length >= 6) {
        this.previewGroup.add(
          createCrispLineSegments(invalidDashPts, { color: palette.invalidGhost, opacity: 0.92, widthPx: 1.65, dashed: true, dashSize: 0.34, gapSize: 0.22 })
        );
      }
      if (waypointPts.length >= 6) {
        this.previewGroup.add(createCrispLineSegments(waypointPts, { color: palette.selectOutline, opacity: 0.98, widthPx: 1.8 }));
      }
      return;
    }

    if (!state.cursorWorld) return;
    const baseY = state.focusFloor * FLOOR_VISUAL_SPACING;

    // 1a. Select mode live hover highlight (shapez 2 whisper-light outline around hovered machine/belt/module)
    if (state.activeTool.kind === 'select') {
      if (state.boxSelectRect) return;
      const col = palette.selectOutline;
      if (state.viewMode === 'building') {
        const cx = Math.floor(state.cursorWorld.x);
        const cy = Math.floor(state.cursorWorld.y);
        const hit = findBuildingAtCell(state.doc, cx, cy, state.focusFloor);
        if (hit) {
          const def = getBuildableDef(hit.type);
          const [w, d] = def ? getBuildingSizeCells(def, hit.rotation) : [1, 1];
          const x0 = hit.x + 0.03;
          const z0 = hit.y + 0.03;
          const x1 = hit.x + w - 0.03;
          const z1 = hit.y + d - 0.03;
          const y = baseY + 0.13;
          const pad = new THREE.Mesh(
            new THREE.PlaneGeometry(Math.max(0.1, x1 - x0), Math.max(0.1, z1 - z0)),
            new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide })
          );
          pad.rotation.x = -Math.PI / 2;
          pad.position.set((x0 + x1) / 2, y - 0.01, (z0 + z1) / 2);
          this.previewGroup.add(pad);
          this.addFlatRectGhost(x0, z0, x1, z1, y, col, 0.72);
        }
      } else {
        const hit = findModuleAtWorldPoint(state.doc, state.cursorWorld.x, state.cursorWorld.y, state.focusFloor);
        if (hit) {
          const def = getModuleDef(hit.type);
          if (def) {
            const [minX, minY, maxX, maxY] = getModuleBoundsM(hit, def);
            const x0 = minX + 0.16;
            const z0 = minY + 0.16;
            const x1 = maxX - 0.16;
            const z1 = maxY - 0.16;
            const y = baseY + 0.14;
            const pad = new THREE.Mesh(
              new THREE.PlaneGeometry(Math.max(1, x1 - x0), Math.max(1, z1 - z0)),
              new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.055, depthWrite: false, side: THREE.DoubleSide })
            );
            pad.rotation.x = -Math.PI / 2;
            pad.position.set((x0 + x1) / 2, y - 0.01, (z0 + z1) / 2);
            this.previewGroup.add(pad);
            this.addFlatRectGhost(x0, z0, x1, z1, y, col, 0.62);
          }
        }
      }
      return;
    }

    // 1b. Demolish brush live target highlight (red footprint + subtle diagonal X on hovered target)
    if (state.activeTool.kind === 'demolish') {
      if (state.boxSelectRect) return;
      const col = palette.invalidGhost;
      if (state.viewMode === 'building') {
        const cx = Math.floor(state.cursorWorld.x);
        const cy = Math.floor(state.cursorWorld.y);
        const hit = findBuildingAtCell(state.doc, cx, cy, state.focusFloor);
        if (hit) {
          const def = getBuildableDef(hit.type);
          const [w, d] = def ? getBuildingSizeCells(def, hit.rotation) : [1, 1];
          const x0 = hit.x + 0.04;
          const z0 = hit.y + 0.04;
          const x1 = hit.x + w - 0.04;
          const z1 = hit.y + d - 0.04;
          const y = baseY + 0.14;
          const pad = new THREE.Mesh(
            new THREE.PlaneGeometry(Math.max(0.1, x1 - x0), Math.max(0.1, z1 - z0)),
            new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide })
          );
          pad.rotation.x = -Math.PI / 2;
          pad.position.set((x0 + x1) / 2, y - 0.01, (z0 + z1) / 2);
          this.previewGroup.add(pad);
          const inset = Math.min(0.22, Math.min(w, d) * 0.22);
          const pts = [
            x0, y, z0, x1, y, z0,
            x1, y, z0, x1, y, z1,
            x1, y, z1, x0, y, z1,
            x0, y, z1, x0, y, z0,
            x0 + inset, y + 0.01, z0 + inset, x1 - inset, y + 0.01, z1 - inset,
            x1 - inset, y + 0.01, z0 + inset, x0 + inset, y + 0.01, z1 - inset,
          ];
          this.previewGroup.add(createCrispLineSegments(pts, { color: col, opacity: 0.98, widthPx: 2.0 }));
        } else {
          this.addFlatRectGhost(cx + 0.1, cy + 0.1, cx + 0.9, cy + 0.9, baseY + 0.1, col, 0.42);
        }
      } else {
        const hit = findModuleAtWorldPoint(state.doc, state.cursorWorld.x, state.cursorWorld.y, state.focusFloor);
        if (hit) {
          const def = getModuleDef(hit.type);
          if (def) {
            const [minX, minY, maxX, maxY] = getModuleBoundsM(hit, def);
            const x0 = minX + 0.18;
            const z0 = minY + 0.18;
            const x1 = maxX - 0.18;
            const z1 = maxY - 0.18;
            const y = baseY + 0.16;
            const pad = new THREE.Mesh(
              new THREE.PlaneGeometry(Math.max(1, x1 - x0), Math.max(1, z1 - z0)),
              new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide })
            );
            pad.rotation.x = -Math.PI / 2;
            pad.position.set((x0 + x1) / 2, y - 0.01, (z0 + z1) / 2);
            this.previewGroup.add(pad);
            const cxM = (x0 + x1) / 2;
            const czM = (z0 + z1) / 2;
            const arm = Math.min(3.2, Math.min(x1 - x0, z1 - z0) * 0.22);
            const pts = [
              x0, y, z0, x1, y, z0,
              x1, y, z0, x1, y, z1,
              x1, y, z1, x0, y, z1,
              x0, y, z1, x0, y, z0,
              cxM - arm, y + 0.01, czM - arm, cxM + arm, y + 0.01, czM + arm,
              cxM + arm, y + 0.01, czM - arm, cxM - arm, y + 0.01, czM + arm,
            ];
            this.previewGroup.add(createCrispLineSegments(pts, { color: col, opacity: 0.98, widthPx: 2.2 }));
          }
        } else {
          const gx = Math.floor(state.cursorWorld.x / STATION_UNIT_M);
          const gy = Math.floor(state.cursorWorld.y / STATION_UNIT_M);
          this.addFlatRectGhost(
            gx * STATION_UNIT_M + 0.3,
            gy * STATION_UNIT_M + 0.3,
            (gx + 1) * STATION_UNIT_M - 0.3,
            (gy + 1) * STATION_UNIT_M - 0.3,
            baseY + 0.12,
            col,
            0.35
          );
        }
      }
      return;
    }

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

    // 4. Blueprint Stamp Ghost (ZERO entity cloning, ZERO spatial re-indexing — hits WeakMap caches in O(1)!)
    if (state.activeTool.kind === 'stamp-blueprint') {
      const bp = state.activeTool.blueprint;
      const anchorX = Math.floor(state.cursorWorld.x);
      const anchorY = Math.floor(state.cursorWorld.y);
      const anchorFloor = state.focusFloor + state.activeTool.floorOffset;
      const hasModules = bp.modules.length > 0;
      const shiftGx = hasModules ? Math.floor(anchorX / STATION_UNIT_M) : 0;
      const shiftGy = hasModules ? Math.floor(anchorY / STATION_UNIT_M) : 0;
      const shiftX = hasModules ? shiftGx * STATION_UNIT_M : anchorX;
      const shiftY = hasModules ? shiftGy * STATION_UNIT_M : anchorY;

      const baseIdx = getDocSpatialIndex(state.doc);

      const validPts: number[] = [];
      const invalidPts: number[] = [];
      const ghostConnValidPts: number[] = [];
      const ghostConnInvalidPts: number[] = [];
      const ghostConnXlPts: number[] = [];
      const showGhostConns = bp.modules.length <= 24;

      for (let i = 0; i < bp.modules.length; i++) {
        const src = bp.modules[i];
        const def = getModuleDef(src.type);
        if (!def) continue;
        const m: PlacedModule = {
          ...src,
          gx: src.gx + shiftGx,
          gy: src.gy + shiftGy,
          floor: src.floor + anchorFloor,
        };
        const issue = validateModulePlacement(state.doc, m);
        const isBad = Boolean(issue && !state.forceReplaceHeld);
        const [minX, minY, maxX, maxY] = getModuleBoundsM(m, def);
        const y = m.floor * FLOOR_VISUAL_SPACING + 0.08;
        pushFlatRectPts(isBad ? invalidPts : validPts, minX + 0.15, minY + 0.15, maxX - 0.15, maxY - 0.15, y);

        if (showGhostConns) {
          const dst = isBad ? ghostConnInvalidPts : ghostConnValidPts;
          for (const c of getModuleWorldConnectors(m, def)) {
            const cyWorld = c.floor * FLOOR_VISUAL_SPACING + 0.1;
            if (c.type.startsWith('Vertical')) {
              const r = c.type === 'Vertical2x2' ? 3.2 : 1.7;
              dst.push(
                c.x, cyWorld, c.y - r, c.x + r, cyWorld, c.y,
                c.x + r, cyWorld, c.y, c.x, cyWorld, c.y + r,
                c.x, cyWorld, c.y + r, c.x - r, cyWorld, c.y,
                c.x - r, cyWorld, c.y, c.x, cyWorld, c.y - r
              );
            } else {
              const isXL = c.type === 'XLarge';
              const span = isXL ? 18 : 5.2;
              pushStationConnectorMarkPts(isXL ? ghostConnXlPts : dst, c.x, cyWorld, c.y, c.rotation, span, 'ghost');
            }
          }
        }
      }

      const maxGhostBlds = 2500;
      const stepBld = bp.buildings.length > maxGhostBlds ? Math.ceil(bp.buildings.length / maxGhostBlds) : 1;
      for (let i = 0; i < bp.buildings.length; i += stepBld) {
        const b = bp.buildings[i];
        const def = getBuildableDef(b.type);
        if (!def) continue;
        const [w, d] = getBuildingSizeCells(def, b.rotation);
        const bx = b.x + shiftX;
        const by = b.y + shiftY;
        const bf = b.floor + anchorFloor;
        const cellMap = !state.forceReplaceHeld ? baseIdx.buildingCellByFloor.get(bf) : undefined;
        let isBad = false;
        // O(w*d) floor + overlap check against WeakMap-cached spatial indexes (state.doc + bp.modules directly!)
        for (let dx = 0; dx < w && !isBad; dx++) {
          for (let dy = 0; dy < d; dy++) {
            const cx = bx + dx;
            const cy = by + dy;
            const onFloor =
              (hasModules && isCellBuildable(bp, b.x + dx, b.y + dy, b.floor)) ||
              isCellBuildable(state.doc, cx, cy, bf);
            if (!onFloor) {
              isBad = true;
              break;
            }
            if (cellMap) {
              const hit = cellMap.get(packCellKey(cx, cy));
              if (hit) {
                if (Array.isArray(hit)) {
                  for (let k = 0; k < hit.length; k++) {
                    const eDef = getBuildableDef(hit[k].type);
                    if (!(def.kind === 'belt' && eDef?.kind === 'belt')) {
                      isBad = true;
                      break;
                    }
                  }
                } else {
                  const eDef = getBuildableDef(hit.type);
                  if (!(def.kind === 'belt' && eDef?.kind === 'belt')) {
                    isBad = true;
                    break;
                  }
                }
              }
            }
          }
        }
        const y = bf * FLOOR_VISUAL_SPACING + 0.09;
        pushFlatRectPts(isBad ? invalidPts : validPts, bx + 0.1, by + 0.1, bx + w - 0.1, by + d - 0.1, y);
      }

      if (validPts.length >= 6) {
        this.previewGroup.add(createCrispLineSegments(validPts, { color: palette.validGhost, opacity: 0.88, widthPx: 1.3 }));
      }
      if (invalidPts.length >= 6) {
        this.previewGroup.add(createCrispLineSegments(invalidPts, { color: palette.invalidGhost, opacity: 0.9, widthPx: 1.35 }));
      }
      if (ghostConnValidPts.length >= 6) {
        this.previewGroup.add(createCrispLineSegments(ghostConnValidPts, { color: palette.validGhost, opacity: 0.96, widthPx: 1.4 }));
      }
      if (ghostConnInvalidPts.length >= 6) {
        this.previewGroup.add(createCrispLineSegments(ghostConnInvalidPts, { color: palette.invalidGhost, opacity: 0.96, widthPx: 1.4 }));
      }
      if (ghostConnXlPts.length >= 6) {
        this.previewGroup.add(createCrispLineSegments(ghostConnXlPts, { color: palette.connXLarge, opacity: 0.96, widthPx: 1.4 }));
      }
    }
  }

  private rebuildBoxSelect(
    state: SceneRenderState,
    palette: CadThemePalette,
    mode: BoxSelectMode = 'replace'
  ): void {
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

    const boxColor =
      mode === 'demolish'
        ? palette.invalidGhost
        : mode === 'sub'
          ? palette.simWarnColor
          : palette.selectOutline;
    const fillOpacity = mode === 'demolish' ? 0.11 : 0.07;

    const geo = new THREE.BoxGeometry(w, h, d);
    const fill = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color: boxColor, transparent: true, opacity: fillOpacity, depthWrite: false })
    );
    fill.position.set(cx, (y0 + y1) / 2, cy);
    this.boxSelectGroup.add(fill);

    const edges = createCrispLineSegments(edgesToPositions(new THREE.EdgesGeometry(geo)), {
      color: boxColor,
      opacity: mode === 'demolish' ? 0.96 : 0.88,
      widthPx: mode === 'demolish' ? 1.55 : 1.35,
    });
    edges.position.copy(fill.position);
    this.boxSelectGroup.add(edges);
  }

  private tick = (now: number): void => {
    this.rafRunning = false;
    this.rafId = 0;
    if (this.disposed) return;

    // Wake sentinel `lastTime === 0`: always give the first wake frame a clean 1/60s step
    // (never `now - performance.now() <= 0` which caused dropped frames on scroll/orbit start!).
    const dt = this.lastTime === 0 ? 1 / 60 : Math.min(0.05, Math.max(0.001, (now - this.lastTime) / 1000));
    this.lastTime = now;

    let right = 0;
    let forward = 0;
    if (this.keysDown.has('KeyD') || this.keysDown.has('ArrowRight')) right += 1;
    if (this.keysDown.has('KeyA') || this.keysDown.has('ArrowLeft')) right -= 1;
    if (this.keysDown.has('KeyW') || this.keysDown.has('ArrowUp')) forward += 1;
    if (this.keysDown.has('KeyS') || this.keysDown.has('ArrowDown')) forward -= 1;
    const movingByKeys = right !== 0 || forward !== 0;
    if (movingByKeys) {
      this.rig.panByAxes(right, forward, dt);
    }

    const cam = this.rig.update(dt, now);
    if (this.dirty || cam.moved || movingByKeys) {
      this.dirty = false;
      this.idleUntilMs = Math.max(this.idleUntilMs, now + 2000);
      this.cullAndSyncVisibleChunks();
      this.renderer.render(this.scene, this.rig.camera);
    } else if (this.pendingTextureUploads.length > 0 || this.pendingWarmupBuckets.length > 0) {
      // Progressive silent idle GPU pre-warm: uploads label mipmaps & chunk VBOs/VAOs in tiny
      // non-blocking slices while idle so subsequent orbits, 22° tilts, and floor switches NEVER spike!
      if (this.pendingTextureUploads.length > 0) {
        const batch = Math.min(4, this.pendingTextureUploads.length);
        for (let i = 0; i < batch; i++) {
          const tex = this.pendingTextureUploads.pop()!;
          this.renderer.initTexture(tex);
        }
      }
      if (this.pendingWarmupBuckets.length > 0) {
        while (this.pendingWarmupBuckets.length > 0) {
          const bucket = this.pendingWarmupBuckets.pop()!;
          if (!bucket.isDisposed && !bucket.isEmpty && !bucket.gpuWarmed) {
            this.warmupBucketGpu(bucket);
            break;
          }
        }
      }
      this.idleUntilMs = Math.max(this.idleUntilMs, now + 500);
    }

    // Keep RAF VSync-locked for 2.0s after last activity (or while idle GPU pre-warm drains),
    // then suspend completely at 0% idle GPU/CPU!
    if (
      cam.active ||
      movingByKeys ||
      this.dirty ||
      this.pendingTextureUploads.length > 0 ||
      this.pendingWarmupBuckets.length > 0 ||
      now < this.idleUntilMs
    ) {
      this.rafRunning = true;
      this.rafId = requestAnimationFrame(this.tick);
    }
  };

  dispose(): void {
    this.disposed = true;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.rafRunning = false;
    this.clearWorldBuckets();
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
