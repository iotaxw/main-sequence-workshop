import * as THREE from 'three';
import { getBuildableDef } from './../core/catalog';
import {
  findBuildingAtCell,
  getBuildingCenterM,
  getBuildingSizeCells,
  getBuildingWorldPorts,
  getModuleCenterM,
  getModuleFloorShift,
  isPortToggleable,
  rotationToDelta,
  STATION_UNIT_M,
} from './../core/geometry';
import type { BlueprintDocument, BuildableDef, PlacedBuilding, PlacedModule, StationModuleDef } from './../core/types';
import { createCrispLineSegments } from './crisp-lines';
import { CAD_THEMES, type CadThemePalette } from './theme';

/**
 * Restrained architectural line-art geometry builders (unified across buildings & non-platform station modules).
 * - Focus-layer primary & detail strokes use pre-baked ink colors at opacity = 1.0 (zero junction dots!).
 * - Vertical top-down view (pitch ~89 deg): extrudeGroup.scale.y -> ~0.008 (pure flat 2D architectural plan).
 * - Tilted 3D perspectives (64 / 42 / 22 deg): extrudeGroup.scale.y -> 1.0 (sculpted hidden-line 3D forms).
 */

export interface MachineLineArtResult {
  root: THREE.Group;
  extrudeGroup: THREE.Group;
  roofHeight: number;
}

function pushSeg(out: number[], x1: number, z1: number, x2: number, z2: number, y1 = 0, y2 = y1): void {
  out.push(x1, y1, z1, x2, y2, z2);
}

function getChamferLoop(hw: number, hd: number, chamfer: number): Array<[number, number]> {
  if (chamfer <= 0.001) {
    return [
      [-hw, -hd],
      [hw, -hd],
      [hw, hd],
      [-hw, hd],
    ];
  }
  const c = Math.min(chamfer, hw * 0.45, hd * 0.45);
  return [
    [-hw + c, -hd],
    [hw - c, -hd],
    [hw, -hd + c],
    [hw, hd - c],
    [hw - c, hd],
    [-hw + c, hd],
    [-hw, hd - c],
    [-hw, -hd + c],
  ];
}

function pushLoop(out: number[], pts: Array<[number, number]>, y = 0): void {
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    pushSeg(out, a[0], a[1], b[0], b[1], y, y);
  }
}

function pushRect(out: number[], hw: number, hd: number, y = 0, chamfer = 0, cx = 0, cz = 0): void {
  const pts = getChamferLoop(hw, hd, chamfer);
  if (cx === 0 && cz === 0) {
    pushLoop(out, pts, y);
  } else {
    pushLoop(
      out,
      pts.map(([x, z]) => [x + cx, z + cz]),
      y
    );
  }
}

function pushArc(
  out: number[],
  cx: number,
  cz: number,
  radius: number,
  startRad: number,
  endRad: number,
  steps: number,
  y = 0
): void {
  for (let i = 0; i < steps; i++) {
    const a0 = startRad + ((endRad - startRad) * i) / steps;
    const a1 = startRad + ((endRad - startRad) * (i + 1)) / steps;
    pushSeg(
      out,
      cx + Math.cos(a0) * radius,
      cz + Math.sin(a0) * radius,
      cx + Math.cos(a1) * radius,
      cz + Math.sin(a1) * radius,
      y,
      y
    );
  }
}

function pushPolygon(out: number[], r: number, sides: number, y = 0, rotOffset = 0, cx = 0, cz = 0): void {
  for (let i = 0; i < sides; i++) {
    const a0 = rotOffset + (i / sides) * Math.PI * 2;
    const a1 = rotOffset + ((i + 1) / sides) * Math.PI * 2;
    pushSeg(
      out,
      cx + Math.cos(a0) * r,
      cz + Math.sin(a0) * r,
      cx + Math.cos(a1) * r,
      cz + Math.sin(a1) * r,
      y,
      y
    );
  }
}

function pushChevron(out: number[], cx: number, cz: number, size: number, y = 0): void {
  pushSeg(out, cx - size * 0.45, cz - size * 0.48, cx + size * 0.48, cz, y, y);
  pushSeg(out, cx + size * 0.48, cz, cx - size * 0.45, cz + size * 0.48, y, y);
}

function buildLineSegments(
  pts: number[],
  color: number,
  opacity: number,
  widthPx = 1.1,
  lodTier: 'primary' | 'detail' | 'micro' = 'primary'
): THREE.Object3D {
  return createCrispLineSegments(pts, { color, opacity, widthPx, lodTier });
}

function createOcclusionMat(color: number, opacity: number, isGhost: boolean): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: isGhost || opacity < 0.99,
    opacity: isGhost ? opacity * 0.08 : opacity * 0.98,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 3,
    depthWrite: !isGhost && opacity >= 0.95,
  });
}

function addChamferPrism(
  target: THREE.Group,
  hw: number,
  hd: number,
  y0: number,
  y1: number,
  chamfer: number,
  fillMat: THREE.Material,
  primaryPts: number[],
  detailPts: number[],
  opts: { cx?: number; cz?: number; omitBottom?: boolean; verticalToPrimary?: boolean } = {}
): void {
  const cx = opts.cx ?? 0;
  const cz = opts.cz ?? 0;
  const loop = getChamferLoop(hw, hd, chamfer).map(([x, z]) => [x + cx, z + cz] as [number, number]);

  const shape = new THREE.Shape();
  shape.moveTo(loop[0][0], -loop[0][1]);
  for (let i = 1; i < loop.length; i++) {
    shape.lineTo(loop[i][0], -loop[i][1]);
  }
  shape.closePath();
  const h = Math.max(0.01, y1 - y0);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 1 });
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, fillMat);
  mesh.position.y = y0;
  target.add(mesh);

  pushLoop(primaryPts, loop, y1 + 0.004);
  if (!opts.omitBottom) {
    pushLoop(detailPts, loop, y0 + 0.002);
  }
  const ribTarget = opts.verticalToPrimary ? primaryPts : detailPts;
  for (const [x, z] of loop) {
    pushSeg(ribTarget, x, z, x, z, y0, y1);
  }
}

function addPolyDrum(
  target: THREE.Group,
  rBottom: number,
  rTop: number,
  sides: number,
  y0: number,
  y1: number,
  rotOffset: number,
  fillMat: THREE.Material,
  primaryPts: number[],
  detailPts: number[],
  opts: { cx?: number; cz?: number; ribCount?: number } = {}
): void {
  const cx = opts.cx ?? 0;
  const cz = opts.cz ?? 0;
  const h = Math.max(0.01, y1 - y0);
  const geo = new THREE.CylinderGeometry(rTop, rBottom, h, sides, 1, false);
  geo.rotateY(Math.PI / 2 - rotOffset);
  const mesh = new THREE.Mesh(geo, fillMat);
  mesh.position.set(cx, y0 + h / 2, cz);
  target.add(mesh);

  pushPolygon(primaryPts, rTop, sides, y1 + 0.004, rotOffset, cx, cz);
  pushPolygon(detailPts, rBottom, sides, y0 + 0.002, rotOffset, cx, cz);

  const ribs = opts.ribCount ?? Math.min(sides, 8);
  const step = Math.max(1, Math.round(sides / ribs));
  for (let i = 0; i < sides; i += step) {
    const a = rotOffset + (i / sides) * Math.PI * 2;
    pushSeg(
      detailPts,
      cx + Math.cos(a) * rBottom,
      cz + Math.sin(a) * rBottom,
      cx + Math.cos(a) * rTop,
      cz + Math.sin(a) * rTop,
      y0,
      y1
    );
  }
}

function addRectBlock(
  target: THREE.Group,
  cx: number,
  cz: number,
  hx: number,
  hz: number,
  y0: number,
  y1: number,
  fillMat: THREE.Material,
  primaryPts: number[],
  detailPts: number[],
  verticalToPrimary = false
): void {
  addChamferPrism(target, hx, hz, y0, y1, 0, fillMat, primaryPts, detailPts, {
    cx,
    cz,
    verticalToPrimary,
  });
}

/**
 * Adds a razor-thin vertical photovoltaic blade sail along X (spanning [x0, x1] and [y0, y1], thin thickness 2*halfZ),
 * with crisp primary silhouette edges and fine PV cell grid lines on both -Z and +Z faces.
 */
function addVerticalSailBlade(
  target: THREE.Group,
  x0: number,
  x1: number,
  cz: number,
  halfZ: number,
  y0: number,
  y1: number,
  fillMat: THREE.Material,
  primaryPts: number[],
  detailPts: number[],
  cols: number,
  rows: number
): void {
  const cx = (x0 + x1) / 2;
  const hx = Math.max(0.05, (x1 - x0) / 2);
  addChamferPrism(target, hx, halfZ, y0, y1, 0, fillMat, primaryPts, detailPts, {
    cx,
    cz,
    verticalToPrimary: true,
  });
  // Ensure the bottom horizontal rim is also a crisp primary silhouette edge when protruding below deck
  pushSeg(primaryPts, x0, cz - halfZ, x1, cz - halfZ, y0, y0);
  pushSeg(primaryPts, x0, cz + halfZ, x1, cz + halfZ, y0, y0);

  // PV cell sub-grid on both -Z and +Z faces of the razor-thin sail
  for (const sz of [-1, 1]) {
    const faceZ = cz + sz * (halfZ + 0.015);
    for (let c = 1; c < cols; c++) {
      const gx = x0 + ((x1 - x0) * c) / cols;
      pushSeg(detailPts, gx, faceZ, gx, faceZ, y0, y1);
    }
    for (let r = 1; r < rows; r++) {
      const gy = y0 + ((y1 - y0) * r) / rows;
      pushSeg(detailPts, x0, faceZ, x1, faceZ, gy, gy);
    }
  }
}

/**
 * Adds a true-to-game 16x16m station hull armour cap:
 * - BPO_StationArmour_01 (top/roof, Z in [0, +4m]): raised chamfered convex armored roof plate with structural corner ribs & central boss.
 * - BPO_StationArmour_01B (bottom/belly vertical flip, Z in [-4m, 0]): inverted recessed belly plate with internal X-truss keel ribs.
 */
function addStationArmourCap(
  target: THREE.Group,
  hw: number,
  hd: number,
  isBottomMirror: boolean,
  fillBase: THREE.Material,
  fillUpper: THREE.Material,
  primaryPts: number[],
  detailPts: number[]
): number {
  const outerW = hw - 0.35;
  const outerD = hd - 0.35;
  const outerChamfer = 2.0;

  if (!isBottomMirror) {
    // Upper roof armour cap (SM2_StationArmour_01: 16x16m x ~2.4m convex stepped hull cap)
    const baseH = 0.85;
    const crownH = 2.45;
    addChamferPrism(target, outerW, outerD, 0, baseH, outerChamfer, fillBase, primaryPts, detailPts);
    addChamferPrism(target, outerW * 0.78, outerD * 0.78, baseH, crownH, 1.65, fillUpper, primaryPts, detailPts);
    // Central bolted armor boss
    addChamferPrism(target, 2.5, 2.5, crownH, crownH + 0.42, 0.55, fillBase, primaryPts, detailPts);
    // Sloped corner reinforcement ribs linking apron to raised crown
    const cOut = outerW - outerChamfer * 0.5;
    const cIn = outerW * 0.78 - 1.65 * 0.5;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        pushSeg(detailPts, sx * cOut, sz * cOut, sx * cIn, sz * cIn, baseH + 0.02, crownH + 0.02);
      }
    }
    // Clean 4-quadrant armor panel expansion seams on crown
    pushSeg(detailPts, -outerW * 0.76, 0, -2.5, 0, crownH + 0.02, crownH + 0.02);
    pushSeg(detailPts, 2.5, 0, outerW * 0.76, 0, crownH + 0.02, crownH + 0.02);
    pushSeg(detailPts, 0, -outerD * 0.76, 0, -2.5, crownH + 0.02, crownH + 0.02);
    pushSeg(detailPts, 0, 2.5, 0, outerD * 0.76, crownH + 0.02, crownH + 0.02);
    return crownH + 0.42;
  }

  // Bottom/belly vertically flipped mirror armour cap (SM2_StationArmour_01B):
  // Clings flush near the TOP of its grid cell (ceiling-mounted against the station deck above) and tapers DOWNWARD!
  const topY = 7.8;
  const skirtBottomY = 6.95;
  const bellyBottomY = 5.35;
  const bossBottomY = 4.95;

  // Upper mounting apron hugging the top of the cell
  addChamferPrism(target, outerW, outerD, skirtBottomY, topY, outerChamfer, fillBase, primaryPts, detailPts);
  // Inverted downward-stepped armored belly plate hanging underneath
  addChamferPrism(target, outerW * 0.78, outerD * 0.78, bellyBottomY, skirtBottomY, 1.65, fillUpper, primaryPts, detailPts);
  // Inverted central keel boss on the underside
  addChamferPrism(target, 2.5, 2.5, bossBottomY, bellyBottomY, 0.55, fillBase, primaryPts, detailPts);

  // Diagonal underside corner gusset ribs sloping downward from outer skirt to belly crown
  const cOut = outerW - outerChamfer * 0.5;
  const cIn = outerW * 0.78 - 1.65 * 0.5;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      pushSeg(detailPts, sx * cOut, sz * cOut, sx * cIn, sz * cIn, skirtBottomY, bellyBottomY);
    }
  }

  // Distinct inverted X-truss structural keel ribs on top mounting face so 2D top-down instantly separates 底 vs 顶
  const innerW = outerW * 0.72;
  const innerD = outerD * 0.72;
  pushRect(detailPts, innerW, innerD, topY + 0.02, 1.3);
  pushSeg(detailPts, -innerW * 0.82, -innerD * 0.82, innerW * 0.82, innerD * 0.82, topY + 0.02, topY + 0.02);
  pushSeg(detailPts, -innerW * 0.82, innerD * 0.82, innerW * 0.82, -innerD * 0.82, topY + 0.02, topY + 0.02);

  return topY;
}

/**
 * Flush elongated rectangular port marker hugging the building perimeter edge.
 * Supports `compact` micro-scale for 1×1 Splitters & 1×2 Balancers so small logistics tiles stay delicate!
 */
function buildFlushPortMarker(
  wx: number,
  y: number,
  wz: number,
  side: 'N' | 'E' | 'S' | 'W',
  enabled: boolean,
  opacity: number,
  palette: CadThemePalette,
  compact = false
): THREE.Object3D {
  const pts: number[] = [];
  const along = compact ? 0.145 : 0.27;
  const thick = compact ? 0.038 : 0.068;
  const inset = compact ? 0.055 : 0.08;
  let offX = 0;
  let offZ = 0;
  let hx = along;
  let hz = thick;

  if (side === 'N') {
    offZ = inset;
  } else if (side === 'S') {
    offZ = -inset;
  } else if (side === 'E') {
    offX = -inset;
    hx = thick;
    hz = along;
  } else {
    offX = inset;
    hx = thick;
    hz = along;
  }

  pushRect(pts, hx, hz, 0, 0);

  if (enabled) {
    if (side === 'N' || side === 'S') {
      pushSeg(pts, -hx * 0.6, 0, hx * 0.6, 0, 0, 0);
    } else {
      pushSeg(pts, 0, -hz * 0.6, 0, hz * 0.6, 0, 0);
    }
  } else {
    pushSeg(pts, -hx * 0.8, -hz * 0.8, hx * 0.8, hz * 0.8, 0, 0);
    pushSeg(pts, hx * 0.8, -hz * 0.8, -hx * 0.8, hz * 0.8, 0, 0);
  }

  const segs = buildLineSegments(
    pts,
    enabled ? palette.portActiveLine : palette.portDisabledLine,
    opacity,
    compact ? 0.95 : 1.08,
    'detail'
  );
  segs.position.set(wx + offX, y, wz + offZ);
  return segs;
}

/**
 * Delicate micro-chevron priority indicator for Splitter / Balancer priority input or output lane.
 */
function buildPortPriorityMarker(
  wx: number,
  y: number,
  wz: number,
  side: 'N' | 'E' | 'S' | 'W',
  isInput: boolean,
  opacity: number,
  palette: CadThemePalette
): THREE.Object3D {
  // Position tucked slightly inside the wall edge
  const inset = 0.155;
  const offX = side === 'E' ? -inset : side === 'W' ? inset : 0;
  const offZ = side === 'S' ? -inset : side === 'N' ? inset : 0;
  // Base direction: outward from building along `side`; flip for input priority so chevron points along item flow!
  const outRot = side === 'E' ? 0 : side === 'S' ? 1 : side === 'W' ? 2 : 3;
  const flowRot = isInput ? (outRot + 2) % 4 : outRot;

  const pts: number[] = [];
  // Compact double-chevron (» / «)
  pushChevron(pts, -0.032, 0, 0.115, 0);
  pushChevron(pts, 0.042, 0, 0.115, 0);

  const color = palette.isLight ? palette.selectOutline : palette.powerTint;
  const segs = buildLineSegments(pts, color, opacity, 1.15, 'primary');
  segs.position.set(wx + offX, y, wz + offZ);
  segs.rotation.y = -flowRot * (Math.PI / 2);
  return segs;
}

/**
 * Tiny crisp diamond pip indicating an active item filter on a Splitter / Balancer output port.
 */
function buildPortFilterPip(
  wx: number,
  y: number,
  wz: number,
  side: 'N' | 'E' | 'S' | 'W',
  hasPriority: boolean,
  opacity: number,
  palette: CadThemePalette
): THREE.Object3D {
  const inset = hasPriority ? 0.255 : 0.165;
  const offX = side === 'E' ? -inset : side === 'W' ? inset : 0;
  const offZ = side === 'S' ? -inset : side === 'N' ? inset : 0;
  const r = 0.058;
  const pts = [
    0, 0, -r, r, 0, 0,
    r, 0, 0, 0, 0, r,
    0, 0, r, -r, 0, 0,
    -r, 0, 0, 0, 0, -r,
  ];
  const segs = buildLineSegments(pts, palette.researchTint, opacity, 1.05, 'detail');
  segs.position.set(wx + offX, y, wz + offZ);
  return segs;
}

/** Precompute O(1) spatial lookup of all logistics cells for fast O(N) belt-turn rendering */
export function buildLogisticsCellMap(doc: BlueprintDocument): Map<string, PlacedBuilding> {
  const map = new Map<string, PlacedBuilding>();
  for (const b of doc.buildings) {
    const def = getBuildableDef(b.type);
    if (!def || !['belt', 'splitter', 'balancer', 'underground'].includes(def.kind)) continue;
    const [w, d] = getBuildingSizeCells(def, b.rotation);
    for (let dx = 0; dx < w; dx++) {
      for (let dy = 0; dy < d; dy++) {
        map.set(`${b.floor}:${b.x + dx},${b.y + dy}`, b);
      }
    }
  }
  return map;
}

/** Check whether a neighbor cell outputs logistics flow into `(targetX, targetY)` */
function doesNeighborFeedCell(
  doc: BlueprintDocument,
  nbX: number,
  nbY: number,
  floor: number,
  dxFromTarget: number,
  dyFromTarget: number,
  cellMap?: Map<string, PlacedBuilding>
): boolean {
  const nb = cellMap ? cellMap.get(`${floor}:${nbX},${nbY}`) : findBuildingAtCell(doc, nbX, nbY, floor);
  if (!nb) return false;
  const nbDef = getBuildableDef(nb.type);
  if (!nbDef || !['belt', 'splitter', 'balancer', 'underground'].includes(nbDef.kind)) return false;
  // Underground IN swallows items underground -> never feeds forward onto the surface tile!
  if (nbDef.kind === 'underground' && nb.undergroundMode !== 'out') return false;
  const [nbOutDx, nbOutDy] = rotationToDelta(nb.rotation);
  return nbOutDx === -dxFromTarget && nbOutDy === -dyFromTarget;
}

/**
 * Minimalist continuous conveyor belt line-art:
 * - Straight-behind flow always takes priority over side merges (never breaks straight lines at T-junctions!).
 * - True C1-tangent circular quarter-arcs on L-turns (zero missing short segments, silky corner curves!).
 * - Solid pre-baked ink at opacity = 1.0 on focus floor (zero dotty tile joints!).
 */
export function buildBeltLineArt(
  doc: BlueprintDocument,
  b: PlacedBuilding,
  def: BuildableDef,
  baseY: number,
  opacity: number,
  isSelected: boolean,
  palette: CadThemePalette = CAD_THEMES['platinum-gold'],
  cellMap?: Map<string, PlacedBuilding>
): THREE.Group {
  const group = new THREE.Group();
  const cx = b.x + 0.5;
  const cz = b.y + 0.5;
  const y = baseY + 0.04;

  const [outDx, outDy] = rotationToDelta(b.rotation);

  // 1. Check straight-behind FIRST so straight runs are never hijacked by side merges!
  let inDir: [number, number] | null = null;
  if (doesNeighborFeedCell(doc, b.x - outDx, b.y - outDy, b.floor, -outDx, -outDy, cellMap)) {
    inDir = [outDx, outDy];
  } else {
    // 2. Otherwise inspect the two perpendicular sides for a clean L-turn
    const perpDirs: Array<[number, number]> = [
      [-outDy, outDx],
      [outDy, -outDx],
    ];
    for (const [dx, dy] of perpDirs) {
      if (doesNeighborFeedCell(doc, b.x + dx, b.y + dy, b.floor, dx, dy, cellMap)) {
        inDir = [-dx, -dy];
        break;
      }
    }
  }

  let localTurn: 'straight' | 'left' | 'right' = 'straight';
  if (inDir) {
    const cross = inDir[0] * outDy - inDir[1] * outDx;
    if (cross > 0) localTurn = 'right';
    else if (cross < 0) localTurn = 'left';
  }

  const r = 0.27;
  let bedGeo: THREE.BufferGeometry;
  if (localTurn === 'straight') {
    bedGeo = new THREE.PlaneGeometry(0.98, r * 2);
    bedGeo.rotateX(-Math.PI / 2);
  } else if (localTurn === 'right') {
    // RingGeometry in XY plane rotated by -PI/2 around X maps (cos(t), -sin(t)) to (X, Z)
    // Pivot at (+0.5, +0.5); we need angles from X=-0.27,Z=+0.5 (t=PI) to X=+0.5,Z=-0.27 (t=PI/2) -> thetaStart = PI/2, length = PI/2
    bedGeo = new THREE.RingGeometry(0.5 - r, 0.5 + r, 14, 1, Math.PI * 0.5, Math.PI * 0.5);
    bedGeo.rotateX(-Math.PI / 2);
    bedGeo.translate(0.5, 0, 0.5);
  } else {
    // Pivot at (+0.5, -0.5); we need (cos(t), -sin(t)) from (-1, 0) [t=PI] to (0, +1) [t=3*PI/2]
    bedGeo = new THREE.RingGeometry(0.5 - r, 0.5 + r, 14, 1, Math.PI, Math.PI * 0.5);
    bedGeo.rotateX(-Math.PI / 2);
    bedGeo.translate(0.5, 0, -0.5);
  }
  const bedMat = new THREE.MeshBasicMaterial({
    color: isSelected ? palette.baseFillSelected : palette.beltTrackFill,
    transparent: opacity < 0.99,
    opacity: opacity * 0.92,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 4,
    depthWrite: false,
  });
  const bed = new THREE.Mesh(bedGeo, bedMat);
  bed.position.set(cx, y - 0.01, cz);
  bed.rotation.y = -b.rotation * (Math.PI / 2);
  group.add(bed);

  const railPts: number[] = [];

  if (localTurn === 'straight') {
    pushSeg(railPts, -0.5, -r, 0.5, -r, 0);
    pushSeg(railPts, -0.5, r, 0.5, r, 0);
  } else if (localTurn === 'right') {
    // Clockwise smooth quarter-circle arc: entering +Z (South) -> exiting +X (East); pivot at (+0.5, +0.5)
    pushArc(railPts, 0.5, 0.5, 0.5 + r, Math.PI, Math.PI * 1.5, 14, 0);
    pushArc(railPts, 0.5, 0.5, 0.5 - r, Math.PI, Math.PI * 1.5, 10, 0);
  } else {
    // Counter-clockwise smooth quarter-circle arc: entering -Z (North) -> exiting +X (East); pivot at (+0.5, -0.5)
    pushArc(railPts, 0.5, -0.5, 0.5 + r, Math.PI, Math.PI * 0.5, 14, 0);
    pushArc(railPts, 0.5, -0.5, 0.5 - r, Math.PI, Math.PI * 0.5, 10, 0);
  }

  const railColor = isSelected
    ? palette.lineSelected
    : def.tier === 3
      ? palette.beltRailMk3
      : def.tier === 2
        ? palette.beltRailMk2
        : palette.beltRailMk1;

  const railLines = buildLineSegments(railPts, railColor, opacity, isSelected ? 1.25 : 1.05, 'detail');
  railLines.position.set(cx, y + 0.01, cz);
  railLines.rotation.y = -b.rotation * (Math.PI / 2);
  group.add(railLines);

  const chevPts: number[] = [];
  if (def.tier === 1) {
    pushChevron(chevPts, 0, 0, 0.22, 0);
  } else if (def.tier === 2) {
    pushChevron(chevPts, -0.09, 0, 0.2, 0);
    pushChevron(chevPts, 0.11, 0, 0.2, 0);
  } else {
    pushChevron(chevPts, -0.16, 0, 0.18, 0);
    pushChevron(chevPts, 0.0, 0, 0.18, 0);
    pushChevron(chevPts, 0.16, 0, 0.18, 0);
  }
  const chevLines = buildLineSegments(
    chevPts,
    isSelected ? palette.lineSelected : palette.beltArrow,
    opacity,
    0.9,
    'micro'
  );
  chevLines.position.set(cx, y + 0.015, cz);
  chevLines.rotation.y = -b.rotation * (Math.PI / 2);
  group.add(chevLines);

  return group;
}

/**
 * Zero-allocation direct belt geometry emitter for batched FloorRenderBucket ingestion.
 * Produces pixel-identical straight/quarter-arc beds, rails, and Mk1-3 chevrons directly into
 * flat float arrays without creating any temporary THREE.Group/Geometry/Material objects.
 */
export function emitBeltDirectToBuffers(
  doc: BlueprintDocument,
  b: PlacedBuilding,
  def: BuildableDef,
  bedTrisOut: number[],
  railPtsOut: number[],
  chevPtsOut: number[]
): void {
  const cx = b.x + 0.5;
  const cz = b.y + 0.5;
  const yBed = 0.03;
  const yRail = 0.05;
  const yChev = 0.055;

  const [outDx, outDy] = rotationToDelta(b.rotation);

  let inDir: [number, number] | null = null;
  if (doesNeighborFeedCell(doc, b.x - outDx, b.y - outDy, b.floor, -outDx, -outDy)) {
    inDir = [outDx, outDy];
  } else {
    const px1 = -outDy;
    const py1 = outDx;
    if (doesNeighborFeedCell(doc, b.x + px1, b.y + py1, b.floor, px1, py1)) {
      inDir = [-px1, -py1];
    } else {
      const px2 = outDy;
      const py2 = -outDx;
      if (doesNeighborFeedCell(doc, b.x + px2, b.y + py2, b.floor, px2, py2)) {
        inDir = [-px2, -py2];
      }
    }
  }

  let localTurn: 0 | 1 | 2 = 0; // 0=straight, 1=right, 2=left
  if (inDir) {
    const cross = inDir[0] * outDy - inDir[1] * outDx;
    if (cross > 0) localTurn = 1;
    else if (cross < 0) localTurn = 2;
  }

  // Rotation around Y by -rot * PI/2 maps local (lx, lz) -> world:
  // rot 0: (+lx, +lz), rot 1: (-lz, +lx), rot 2: (-lx, -lz), rot 3: (+lz, -lx)
  const rot = b.rotation;
  const toWX = (lx: number, lz: number) =>
    cx + (rot === 0 ? lx : rot === 1 ? -lz : rot === 2 ? -lx : lz);
  const toWZ = (lx: number, lz: number) =>
    cz + (rot === 0 ? lz : rot === 1 ? lx : rot === 2 ? -lz : -lx);

  const pushTri = (ax: number, az: number, bx: number, bz: number, dx: number, dz: number) => {
    bedTrisOut.push(
      toWX(ax, az), yBed, toWZ(ax, az),
      toWX(bx, bz), yBed, toWZ(bx, bz),
      toWX(dx, dz), yBed, toWZ(dx, dz)
    );
  };

  const pushWorldSeg = (out: number[], x1: number, z1: number, x2: number, z2: number, y: number) => {
    out.push(toWX(x1, z1), y, toWZ(x1, z1), toWX(x2, z2), y, toWZ(x2, z2));
  };

  const r = 0.27;
  if (localTurn === 0) {
    // Straight bed quad (two CCW triangles looking from +Y)
    pushTri(-0.49, -r, -0.49, r, 0.49, r);
    pushTri(-0.49, -r, 0.49, r, 0.49, -r);
    // Straight rails
    pushWorldSeg(railPtsOut, -0.5, -r, 0.5, -r, yRail);
    pushWorldSeg(railPtsOut, -0.5, r, 0.5, r, yRail);
  } else {
    // Quarter-circle arc bed + inner/outer rails
    const isRight = localTurn === 1;
    const pivX = 0.5;
    const pivZ = isRight ? 0.5 : -0.5;
    const rIn = 0.5 - r;
    const rOut = 0.5 + r;
    const steps = 10;
    const aStart = Math.PI;
    const aEnd = isRight ? Math.PI * 1.5 : Math.PI * 0.5;
    const stepA = (aEnd - aStart) / steps;

    for (let i = 0; i < steps; i++) {
      const a0 = aStart + i * stepA;
      const a1 = a0 + stepA;
      const c0 = Math.cos(a0);
      const s0 = Math.sin(a0);
      const c1 = Math.cos(a1);
      const s1 = Math.sin(a1);
      const ix0 = pivX + c0 * rIn;
      const iz0 = pivZ + s0 * rIn;
      const ox0 = pivX + c0 * rOut;
      const oz0 = pivZ + s0 * rOut;
      const ix1 = pivX + c1 * rIn;
      const iz1 = pivZ + s1 * rIn;
      const ox1 = pivX + c1 * rOut;
      const oz1 = pivZ + s1 * rOut;

      if (isRight) {
        pushTri(ix0, iz0, ox0, oz0, ox1, oz1);
        pushTri(ix0, iz0, ox1, oz1, ix1, iz1);
      } else {
        pushTri(ix0, iz0, ox1, oz1, ox0, oz0);
        pushTri(ix0, iz0, ix1, iz1, ox1, oz1);
      }
      pushWorldSeg(railPtsOut, ox0, oz0, ox1, oz1, yRail);
      pushWorldSeg(railPtsOut, ix0, iz0, ix1, iz1, yRail);
    }
  }

  // Tier 1 / 2 / 3 chevrons
  const emitChev = (ox: number, size: number) => {
    const xL = ox - size * 0.45;
    const xR = ox + size * 0.48;
    const zH = size * 0.48;
    pushWorldSeg(chevPtsOut, xL, -zH, xR, 0, yChev);
    pushWorldSeg(chevPtsOut, xR, 0, xL, zH, yChev);
  };
  if (def.tier === 1) {
    emitChev(0, 0.22);
  } else if (def.tier === 2) {
    emitChev(-0.09, 0.2);
    emitChev(0.11, 0.2);
  } else {
    emitChev(-0.16, 0.18);
    emitChev(0.0, 0.18);
    emitChev(0.16, 0.18);
  }
}

/**
 * Pitch-responsive sculpted architectural line-art for any non-belt interior building/machine.
 */
export function buildMachineLineArt(
  b: PlacedBuilding,
  def: BuildableDef,
  baseY: number,
  opacity: number,
  isSelected: boolean,
  palette: CadThemePalette = CAD_THEMES['platinum-gold'],
  ghostTint?: number
): MachineLineArtResult {
  const root = new THREE.Group();
  const [cx, cz] = getBuildingCenterM(b, def);
  const [w, d] = getBuildingSizeCells(def, b.rotation);
  const floorY = baseY + 0.032;

  const lw = def.size[0];
  const ld = def.size[1];
  const inset = Math.min(lw, ld) >= 3 ? 0.14 : 0.08;
  const hw = lw / 2 - inset;
  const hd = ld / 2 - inset;
  const minH = Math.min(hw, hd);
  const isGhost = ghostTint !== undefined;

  const plateGeo = new THREE.PlaneGeometry(w - inset * 2, d - inset * 2);
  plateGeo.rotateX(-Math.PI / 2);
  const plateMat = new THREE.MeshBasicMaterial({
    color: isGhost ? ghostTint : isSelected ? palette.baseFillSelected : palette.baseFill,
    transparent: isGhost || opacity < 0.99,
    opacity: isGhost ? opacity * 0.08 : opacity * 0.98,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 4,
    depthWrite: false,
  });
  const plate = new THREE.Mesh(plateGeo, plateMat);
  plate.position.set(cx, floorY, cz);
  root.add(plate);

  const extrudeGroup = new THREE.Group();
  extrudeGroup.position.set(cx, floorY + 0.005, cz);
  extrudeGroup.rotation.y = -b.rotation * (Math.PI / 2);

  const fillBase = createOcclusionMat(
    isGhost ? ghostTint : isSelected ? palette.bodyFillSelected : palette.bodyFill,
    opacity,
    isGhost
  );
  const fillUpper = createOcclusionMat(
    isGhost ? ghostTint : isSelected ? palette.bodyFillSelected : palette.bodyFillUpper,
    opacity,
    isGhost
  );

  const primaryPts: number[] = [];
  const detailPts: number[] = [];
  let roofHeight = 1.2;

  const isBeltVariant = def.kind === 'underground' || def.kind === 'splitter' || def.kind === 'balancer';
  const primaryColor = isGhost
    ? ghostTint
    : isSelected
      ? palette.lineSelected
      : def.kind === 'underground'
        ? palette.undergroundNodeColor
        : def.kind === 'splitter' || def.kind === 'balancer'
          ? palette.logisticsNodeColor
          : def.kind === 'research'
            ? palette.researchTint
            : def.kind === 'reactor'
              ? palette.powerTint
              : palette.linePrimary;

  switch (def.id) {
    case 'DAT_Refinery': {
      // Binary real height 3.32m (3x3) -> 2.85m tall smelting furnace stack
      roofHeight = 2.85;
      addChamferPrism(extrudeGroup, hw, hd, 0, 0.78, 0.34, fillBase, primaryPts, detailPts);
      addPolyDrum(extrudeGroup, minH * 0.62, minH * 0.52, 16, 0.78, 2.28, 0, fillUpper, primaryPts, detailPts, {
        ribCount: 8,
      });
      addPolyDrum(extrudeGroup, minH * 0.34, minH * 0.28, 8, 2.28, roofHeight, Math.PI / 8, fillBase, primaryPts, detailPts, {
        ribCount: 4,
      });
      const r0 = minH * 0.54;
      const r1 = minH * 0.92;
      for (let i = 0; i < 4; i++) {
        const a = Math.PI / 4 + (i * Math.PI) / 2;
        pushSeg(detailPts, Math.cos(a) * r1, Math.sin(a) * r1, Math.cos(a) * r0, Math.sin(a) * r0, 0.78, 2.15);
      }
      break;
    }

    case 'DAT_Assembler': {
      // Binary real height 4.10m (5x5) -> 3.50m tall stepped fabricator with overhead gantry crown
      roofHeight = 3.5;
      addChamferPrism(extrudeGroup, hw, hd, 0, 1.05, 0.38, fillBase, primaryPts, detailPts);
      addChamferPrism(extrudeGroup, hw * 0.74, hd * 0.74, 1.05, 2.52, 0.22, fillUpper, primaryPts, detailPts);
      addPolyDrum(extrudeGroup, minH * 0.38, minH * 0.34, 4, 2.52, roofHeight, 0, fillBase, primaryPts, detailPts, {
        ribCount: 4,
      });
      pushSeg(detailPts, -hw * 0.74, 0, -minH * 0.38, 0, 2.53, 2.53);
      pushSeg(detailPts, minH * 0.38, 0, hw * 0.74, 0, 2.53, 2.53);
      pushSeg(detailPts, 0, -hd * 0.74, 0, -minH * 0.38, 2.53, 2.53);
      pushSeg(detailPts, 0, minH * 0.38, 0, hd * 0.74, 2.53, 2.53);
      break;
    }

    case 'DAT_AdvancedAssembler': {
      // Binary real height 3.80m (9x9) -> 3.35m wide heavy multi-stage assembly hall
      roofHeight = 3.35;
      addChamferPrism(extrudeGroup, hw, hd, 0, 1.02, 0.58, fillBase, primaryPts, detailPts);
      addChamferPrism(extrudeGroup, hw * 0.82, hd * 0.82, 1.02, 2.18, 0.34, fillUpper, primaryPts, detailPts);
      addPolyDrum(extrudeGroup, minH * 0.46, minH * 0.38, 4, 2.18, 2.96, 0, fillBase, primaryPts, detailPts, {
        ribCount: 4,
      });
      addChamferPrism(extrudeGroup, minH * 0.2, minH * 0.2, 2.96, roofHeight, 0, fillUpper, primaryPts, detailPts);
      pushSeg(detailPts, -hw * 0.82, 0, hw * 0.82, 0, 2.19, 2.19);
      pushSeg(detailPts, 0, -hd * 0.82, 0, hd * 0.82, 2.19, 2.19);
      break;
    }

    case 'DAT_EnrichmentChamber': {
      // Binary real height 2.49m (9x9) -> 2.22m wide, low-profile centrifuge ring (shorter than AdvancedAssembler!)
      roofHeight = 2.22;
      addChamferPrism(extrudeGroup, hw, hd, 0, 0.58, 0.72, fillBase, primaryPts, detailPts);
      addPolyDrum(extrudeGroup, minH * 0.82, minH * 0.78, 24, 0.58, 1.38, 0, fillUpper, primaryPts, detailPts, {
        ribCount: 8,
      });
      addPolyDrum(extrudeGroup, minH * 0.52, minH * 0.46, 16, 1.38, 1.88, 0, fillBase, primaryPts, detailPts, {
        ribCount: 8,
      });
      addPolyDrum(extrudeGroup, minH * 0.24, minH * 0.18, 12, 1.88, roofHeight, 0, fillUpper, primaryPts, detailPts, {
        ribCount: 4,
      });
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3;
        pushSeg(
          detailPts,
          Math.cos(a) * minH * 0.48,
          Math.sin(a) * minH * 0.48,
          Math.cos(a) * minH * 0.78,
          Math.sin(a) * minH * 0.78,
          1.39,
          1.39
        );
      }
      break;
    }

    case 'DAT_Supercomputer': {
      // Binary real height 4.88m (7x7) -> 4.20m towering 5-blade monolith array + overhead cryo manifold
      roofHeight = 4.2;
      addChamferPrism(extrudeGroup, hw, hd, 0, 0.62, 0.42, fillBase, primaryPts, detailPts);
      const bladeCount = 5;
      const spanX = hw * 1.5;
      for (let i = 0; i < bladeCount; i++) {
        const x = -spanX / 2 + (spanX * i) / (bladeCount - 1);
        addRectBlock(extrudeGroup, x, 0, 0.22, hd * 0.74, 0.62, 3.72, fillUpper, primaryPts, detailPts, true);
        // Horizontal compute-bay shelf seams along the tall blade faces
        for (const gy of [1.45, 2.25, 3.05]) {
          pushSeg(detailPts, x - 0.23, -hd * 0.74, x - 0.23, hd * 0.74, gy, gy);
          pushSeg(detailPts, x + 0.23, -hd * 0.74, x + 0.23, hd * 0.74, gy, gy);
        }
      }
      addRectBlock(extrudeGroup, 0, 0, hw * 0.88, 0.34, 3.72, roofHeight, fillBase, primaryPts, detailPts);
      break;
    }

    case 'DAT_GrowthChamber': {
      // Binary real height 2.73m (7x7) -> 2.42m low hexagonal geodesic bio-dome
      roofHeight = 2.42;
      addChamferPrism(extrudeGroup, hw, hd, 0, 0.64, 0.68, fillBase, primaryPts, detailPts);
      addPolyDrum(extrudeGroup, minH * 0.78, minH * 0.72, 6, 0.64, 1.72, Math.PI / 6, fillUpper, primaryPts, detailPts, {
        ribCount: 6,
      });
      addPolyDrum(extrudeGroup, minH * 0.72, minH * 0.26, 6, 1.72, roofHeight, Math.PI / 6, fillBase, primaryPts, detailPts, {
        ribCount: 6,
      });
      break;
    }

    case 'DAT_RelicSynthesizer': {
      // Binary real height 3.99m (9x9) -> 3.55m harmonic chamber with 4 tall corner emitter pylons
      roofHeight = 3.55;
      addChamferPrism(extrudeGroup, hw, hd, 0, 0.88, 0.9, fillBase, primaryPts, detailPts);
      addPolyDrum(extrudeGroup, minH * 0.68, minH * 0.6, 4, 0.88, 2.05, 0, fillUpper, primaryPts, detailPts, {
        ribCount: 4,
      });
      const pOff = minH * 0.64;
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          addRectBlock(extrudeGroup, sx * pOff, sz * pOff, 0.42, 0.42, 0.88, 3.12, fillBase, primaryPts, detailPts, true);
          pushSeg(detailPts, sx * pOff, sz * pOff, 0, 0, 3.12, roofHeight - 0.12);
        }
      }
      addPolyDrum(extrudeGroup, minH * 0.26, minH * 0.14, 8, 2.05, roofHeight, Math.PI / 8, fillUpper, primaryPts, detailPts, {
        ribCount: 4,
      });
      break;
    }

    case 'DAT_ReactorMachine': {
      // Binary real height 4.54m (6x6) -> 3.95m tall armored fusion core + 3 heavy radial radiator fins
      roofHeight = 3.95;
      addChamferPrism(extrudeGroup, hw, hd, 0, 1.02, 0.62, fillBase, primaryPts, detailPts);
      addPolyDrum(extrudeGroup, minH * 0.48, minH * 0.4, 12, 1.02, 3.42, 0, fillUpper, primaryPts, detailPts, {
        ribCount: 6,
      });
      addPolyDrum(extrudeGroup, minH * 0.36, minH * 0.24, 12, 3.42, roofHeight, 0, fillBase, primaryPts, detailPts, {
        ribCount: 6,
      });
      for (let i = 0; i < 3; i++) {
        const a = (i * Math.PI * 2) / 3 - Math.PI / 2;
        const rIn = minH * 0.44;
        const rOut = minH * 0.92;
        pushSeg(primaryPts, Math.cos(a) * rIn, Math.sin(a) * rIn, Math.cos(a) * rOut, Math.sin(a) * rOut, 3.25, 1.02);
        pushSeg(primaryPts, Math.cos(a) * rOut, Math.sin(a) * rOut, Math.cos(a) * rOut, Math.sin(a) * rOut, 1.02, 1.92);
        pushSeg(detailPts, Math.cos(a) * rIn, Math.sin(a) * rIn, Math.cos(a) * rOut, Math.sin(a) * rOut, 1.02, 1.02);
        pushSeg(detailPts, Math.cos(a) * rIn, Math.sin(a) * rIn, Math.cos(a) * rOut, Math.sin(a) * rOut, 2.35, 1.92);
      }
      break;
    }

    case 'DAT_Container':
    case 'DAT_Container_2': {
      // Binary real heights: Container 2.34m (2x2) -> 1.95m; Container_2 2.40m (4x4) -> 2.10m
      const isLarge = def.id === 'DAT_Container_2';
      roofHeight = isLarge ? 2.1 : 1.95;
      addChamferPrism(extrudeGroup, hw, hd, 0, roofHeight * 0.8, isLarge ? 0.28 : 0.16, fillBase, primaryPts, detailPts);
      addChamferPrism(
        extrudeGroup,
        hw * 0.84,
        hd * 0.84,
        roofHeight * 0.8,
        roofHeight,
        isLarge ? 0.18 : 0.1,
        fillUpper,
        primaryPts,
        detailPts
      );
      const divs = isLarge ? 3 : 2;
      for (let i = 1; i < divs; i++) {
        const t = -1 + (2 * i) / divs;
        pushSeg(detailPts, -hw * 0.84, hd * 0.84 * t, hw * 0.84, hd * 0.84 * t, roofHeight + 0.005, roofHeight + 0.005);
        pushSeg(detailPts, hw * 0.84 * t, -hd * 0.84, hw * 0.84 * t, hd * 0.84, roofHeight + 0.005, roofHeight + 0.005);
      }
      break;
    }

    case 'DAT_Splitter':
    case 'DAT_Splitter_2':
    case 'DAT_Splitter_3': {
      roofHeight = 0.46;
      addChamferPrism(extrudeGroup, hw, hd, 0, roofHeight, 0.12, fillBase, primaryPts, detailPts);
      pushSeg(primaryPts, -hw * 0.72, 0, hw * 0.72, 0, roofHeight + 0.006, roofHeight + 0.006);
      pushSeg(primaryPts, 0, -hd * 0.72, 0, hd * 0.72, roofHeight + 0.006, roofHeight + 0.006);
      pushChevron(primaryPts, hw * 0.24, 0, 0.24, roofHeight + 0.008);
      break;
    }

    case 'DAT_BeltBalancer_01':
    case 'DAT_BeltBalancer_02':
    case 'DAT_BeltBalancer_03': {
      roofHeight = 0.56;
      addChamferPrism(extrudeGroup, hw, hd, 0, 0.34, 0.12, fillBase, primaryPts, detailPts);
      addChamferPrism(extrudeGroup, hw * 0.78, hd * 0.82, 0.34, roofHeight, 0.08, fillUpper, primaryPts, detailPts);
      pushSeg(primaryPts, -hw * 0.62, -hd * 0.52, hw * 0.62, hd * 0.52, roofHeight + 0.008, roofHeight + 0.008);
      pushSeg(primaryPts, -hw * 0.62, hd * 0.52, hw * 0.62, -hd * 0.52, roofHeight + 0.008, roofHeight + 0.008);
      pushChevron(detailPts, hw * 0.34, -hd * 0.48, 0.16, roofHeight + 0.008);
      pushChevron(detailPts, hw * 0.34, hd * 0.48, 0.16, roofHeight + 0.008);
      break;
    }

    case 'DAT_UndergroundBelt':
    case 'DAT_UndergroundBelt_2':
    case 'DAT_UndergroundBelt_3': {
      roofHeight = 0.44;
      const isOut = b.undergroundMode === 'out';
      const hoodCenter = isOut ? -hw * 0.22 : hw * 0.22;
      addRectBlock(extrudeGroup, hoodCenter, 0, hw * 0.68, hd * 0.88, 0, roofHeight, fillBase, primaryPts, detailPts);
      pushChevron(primaryPts, isOut ? 0.18 : -0.18, 0, 0.24, roofHeight + 0.008);
      break;
    }

    case 'DAT_Teleporter': {
      // Binary real height 2.86m (4x4) -> 2.52m circular pad + twin vertical portal arch pylons + overhead lintel
      roofHeight = 2.52;
      addChamferPrism(extrudeGroup, hw, hd, 0, 0.42, 0.52, fillBase, primaryPts, detailPts);
      addPolyDrum(extrudeGroup, minH * 0.76, minH * 0.72, 20, 0.42, 0.74, 0, fillUpper, primaryPts, detailPts, {
        ribCount: 8,
      });
      pushPolygon(detailPts, minH * 0.44, 16, 0.75, 0, 0, 0);
      // Twin portal arch pylons flanking the pad
      const pylonZ = hd * 0.74;
      addRectBlock(extrudeGroup, 0, -pylonZ, 0.34, 0.28, 0.42, roofHeight, fillBase, primaryPts, detailPts, true);
      addRectBlock(extrudeGroup, 0, pylonZ, 0.34, 0.28, 0.42, roofHeight, fillBase, primaryPts, detailPts, true);
      // Overhead portal arch lintel spanning between pylons
      addRectBlock(extrudeGroup, 0, 0, 0.28, pylonZ + 0.28, roofHeight - 0.32, roofHeight, fillUpper, primaryPts, detailPts);
      break;
    }

    case 'DAT_WorkbenchMachine': {
      // Binary real height 2.31m (2x4) -> 1.98m stepped fabrication bench + rear tool canopy
      roofHeight = 1.98;
      addChamferPrism(extrudeGroup, hw, hd, 0, 1.12, 0.18, fillBase, primaryPts, detailPts);
      addRectBlock(extrudeGroup, -hw * 0.28, 0, hw * 0.52, hd * 0.86, 1.12, roofHeight, fillUpper, primaryPts, detailPts);
      break;
    }

    case 'DAT_Armoury': {
      // Binary real height 2.96m (4x4) -> 2.55m armored vault + dorsal rack canopy
      roofHeight = 2.55;
      addChamferPrism(extrudeGroup, hw, hd, 0, 1.48, 0.26, fillBase, primaryPts, detailPts);
      addChamferPrism(extrudeGroup, hw * 0.74, hd * 0.74, 1.48, roofHeight, 0.16, fillUpper, primaryPts, detailPts);
      pushSeg(detailPts, -hw * 0.74, 0, hw * 0.74, 0, roofHeight + 0.006, roofHeight + 0.006);
      break;
    }

    case 'DAT_RelicAnalyzer': {
      // Binary real height 2.33m (3x3) -> 2.02m octagonal relic scanner drum + optical turret
      roofHeight = 2.02;
      addChamferPrism(extrudeGroup, hw, hd, 0, 0.68, 0.28, fillBase, primaryPts, detailPts);
      addPolyDrum(extrudeGroup, minH * 0.7, minH * 0.6, 8, 0.68, 1.58, Math.PI / 8, fillUpper, primaryPts, detailPts, {
        ribCount: 8,
      });
      addPolyDrum(extrudeGroup, minH * 0.32, minH * 0.22, 8, 1.58, roofHeight, Math.PI / 8, fillBase, primaryPts, detailPts, {
        ribCount: 4,
      });
      pushSeg(detailPts, -minH * 0.56, 0, minH * 0.56, 0, 1.59, 1.59);
      pushSeg(detailPts, 0, -minH * 0.56, 0, minH * 0.56, 1.59, 1.59);
      break;
    }

    default: {
      if (def.kind === 'research') {
        if (def.id === 'DAT_QuantumSciLab') {
          // Binary real height 5.39m (9x9) -> 4.65m tallest interior building!
          roofHeight = 4.65;
          addChamferPrism(extrudeGroup, hw, hd, 0, 1.15, 0.62, fillBase, primaryPts, detailPts);
          addPolyDrum(extrudeGroup, minH * 0.74, minH * 0.66, 24, 1.15, 2.95, 0, fillUpper, primaryPts, detailPts, {
            ribCount: 8,
          });
          addPolyDrum(extrudeGroup, minH * 0.34, minH * 0.24, 12, 2.95, roofHeight, 0, fillBase, primaryPts, detailPts, {
            ribCount: 6,
          });
          for (let i = 0; i < 4; i++) {
            const a = Math.PI / 4 + (i * Math.PI) / 2;
            pushSeg(
              primaryPts,
              Math.cos(a) * minH * 0.72,
              Math.sin(a) * minH * 0.72,
              Math.cos(a) * minH * 0.32,
              Math.sin(a) * minH * 0.32,
              1.15,
              4.15
            );
          }
        } else if (def.id === 'DAT_AstroSciLab') {
          // Binary real height 1.48m (5x5) -> 1.38m sleek LOW wide celestial orrery table!
          roofHeight = 1.38;
          addChamferPrism(extrudeGroup, hw, hd, 0, 0.46, 0.42, fillBase, primaryPts, detailPts);
          addPolyDrum(extrudeGroup, minH * 0.82, minH * 0.74, 16, 0.46, 1.02, 0, fillUpper, primaryPts, detailPts, {
            ribCount: 8,
          });
          addPolyDrum(extrudeGroup, minH * 0.42, minH * 0.16, 12, 1.02, roofHeight, 0, fillBase, primaryPts, detailPts, {
            ribCount: 6,
          });
        } else if (def.id === 'DAT_XenoSciLab') {
          // Binary real height 4.61m (5x5) -> 3.95m tall hexagonal bio-containment tower!
          roofHeight = 3.95;
          addChamferPrism(extrudeGroup, hw, hd, 0, 0.95, 0.42, fillBase, primaryPts, detailPts);
          addPolyDrum(extrudeGroup, minH * 0.7, minH * 0.6, 6, 0.95, 3.15, Math.PI / 6, fillUpper, primaryPts, detailPts, {
            ribCount: 6,
          });
          addPolyDrum(extrudeGroup, minH * 0.38, minH * 0.22, 3, 3.15, roofHeight, 0, fillBase, primaryPts, detailPts, {
            ribCount: 3,
          });
        } else if (def.id === 'DAT_ElectroSciLab') {
          // Binary real height 3.31m (5x5) -> 2.85m diamond high-voltage coil lab
          roofHeight = 2.85;
          addChamferPrism(extrudeGroup, hw, hd, 0, 0.85, 0.4, fillBase, primaryPts, detailPts);
          addPolyDrum(extrudeGroup, minH * 0.74, minH * 0.64, 4, 0.85, 2.08, 0, fillUpper, primaryPts, detailPts, {
            ribCount: 4,
          });
          addPolyDrum(extrudeGroup, minH * 0.28, minH * 0.26, 8, 2.08, roofHeight, 0, fillBase, primaryPts, detailPts, {
            ribCount: 4,
          });
        } else if (def.id === 'DAT_CompSciLab') {
          // Binary real height 2.64m (3x3) -> 2.28m compact dual-rack compute lab
          roofHeight = 2.28;
          addChamferPrism(extrudeGroup, hw, hd, 0, 0.72, 0.24, fillBase, primaryPts, detailPts);
          addChamferPrism(extrudeGroup, hw * 0.68, hd * 0.68, 0.72, roofHeight, 0.14, fillUpper, primaryPts, detailPts, {
            verticalToPrimary: true,
          });
        } else {
          // DAT_MatSciLab (3x3, real 3.01m -> 2.60m) & fallback research lab
          roofHeight = def.id === 'DAT_MatSciLab' ? 2.6 : 2.2;
          addChamferPrism(extrudeGroup, hw, hd, 0, roofHeight * 0.32, Math.min(0.42, minH * 0.24), fillBase, primaryPts, detailPts);
          addPolyDrum(extrudeGroup, minH * 0.68, minH * 0.58, 16, roofHeight * 0.32, roofHeight * 0.82, 0, fillUpper, primaryPts, detailPts, {
            ribCount: 8,
          });
          addPolyDrum(extrudeGroup, minH * 0.42, minH * 0.34, 12, roofHeight * 0.82, roofHeight, 0, fillBase, primaryPts, detailPts, {
            ribCount: 6,
          });
        }
        pushSeg(detailPts, -minH * 0.68, 0, minH * 0.68, 0, roofHeight + 0.005, roofHeight + 0.005);
        pushSeg(detailPts, 0, -minH * 0.68, 0, minH * 0.68, roofHeight + 0.005, roofHeight + 0.005);
      } else {
        roofHeight = def.id === 'DAT_SignWall' ? 1.1 : 0.62;
        addChamferPrism(extrudeGroup, hw * 0.82, hd * 0.82, 0, roofHeight, 0.08, fillBase, primaryPts, detailPts);
      }
      break;
    }
  }

  // Solid pre-baked ink at opacity = 1.0 on focus floor (zero overlapping vertex dots!)
  if (primaryPts.length > 0) {
    extrudeGroup.add(
      buildLineSegments(
        primaryPts,
        primaryColor,
        isGhost ? opacity * 0.94 : opacity,
        isSelected ? 1.5 : isBeltVariant ? 1.16 : 1.22,
        'primary'
      )
    );
  }
  if (detailPts.length > 0) {
    extrudeGroup.add(
      buildLineSegments(
        detailPts,
        isGhost ? ghostTint : isSelected ? palette.linePrimary : palette.lineDetail,
        isGhost ? opacity * 0.62 : opacity,
        0.85,
        'detail'
      )
    );
  }

  root.add(extrudeGroup);

  const isLogistics = def.kind === 'splitter' || def.kind === 'balancer';
  if (def.configurablePorts || isLogistics) {
    const worldPorts = getBuildingWorldPorts(b, def);
    const markerOp = isGhost ? opacity * 0.82 : opacity;
    for (const wp of worldPorts) {
      const idx = wp.port.index;
      const canToggle = isPortToggleable(def, wp.port);
      const isPriorityIn = isLogistics && b.priorityIn === idx;
      const isPriorityOut = isLogistics && b.priorityOut === idx;
      const hasFilter = isLogistics && Boolean(b.portFilters?.[idx]);

      // Only draw enable/disable port slots for ports that are genuinely toggleable!
      // (Never draws port-config slots on fixed always-on Splitter input or Balancer lanes!)
      if (canToggle) {
        root.add(
          buildFlushPortMarker(
            wp.worldX,
            floorY + 0.025,
            wp.worldY,
            wp.side,
            wp.enabled,
            markerOp,
            palette,
            isLogistics
          )
        );
      }

      if ((isPriorityIn || isPriorityOut) && wp.enabled) {
        root.add(
          buildPortPriorityMarker(
            wp.worldX,
            floorY + 0.036,
            wp.worldY,
            wp.side,
            isPriorityIn,
            markerOp,
            palette
          )
        );
      }

      if (hasFilter && wp.enabled) {
        root.add(
          buildPortFilterPip(
            wp.worldX,
            floorY + 0.038,
            wp.worldY,
            wp.side,
            isPriorityIn || isPriorityOut,
            markerOp,
            palette
          )
        );
      }
    }
  }

  return { root, extrudeGroup, roofHeight };
}

/**
 * Unified pitch-responsive architectural 3D/2D line-art for ALL non-factory-floor station modules.
 * Styled to match Main Sequence's real in-game volume & negative-space proportions (NO full-grid cubes!):
 * Attachment modules dock cleanly from their real -X connector wall (x = -lw/2) with open space around them.
 */
export function buildStationModuleArt(
  mod: PlacedModule,
  def: StationModuleDef,
  baseY: number,
  opacity: number,
  isSelected: boolean,
  palette: CadThemePalette = CAD_THEMES['platinum-gold'],
  ghostTint?: number
): MachineLineArtResult {
  const root = new THREE.Group();
  const [cx, cz] = getModuleCenterM(mod, def);
  const floorY = baseY;
  const isGhost = ghostTint !== undefined;

  // Local unrotated grid cell span (meters)
  const lw = def.sizeUnits[0] * STATION_UNIT_M;
  const ld = def.sizeUnits[1] * STATION_UNIT_M;
  const hw = lw / 2;
  const hd = ld / 2;

  const extrudeGroup = new THREE.Group();
  extrudeGroup.position.set(cx, floorY, cz);
  extrudeGroup.rotation.y = -mod.rotation * (Math.PI / 2);

  const fillBase = createOcclusionMat(
    isGhost ? ghostTint : isSelected ? palette.bodyFillSelected : palette.bodyFill,
    opacity,
    isGhost
  );
  const fillUpper = createOcclusionMat(
    isGhost ? ghostTint : isSelected ? palette.bodyFillSelected : palette.bodyFillUpper,
    opacity,
    isGhost
  );

  const primaryPts: number[] = [];
  const detailPts: number[] = [];
  let roofHeight = 3.2;

  let accentColor = palette.linePrimary;
  if (def.id.includes('Armour')) accentColor = palette.armourTint;
  else if (def.id.includes('Turret')) accentColor = palette.turretTint;
  else if (def.id.includes('Solar')) accentColor = palette.solarTint;
  else if (def.id.includes('Observatory') || def.id.includes('Scanner')) accentColor = palette.researchTint;
  else if (def.id.includes('Command')) accentColor = palette.powerTint;

  const primaryColor = isGhost ? ghostTint : isSelected ? palette.lineSelected : accentColor;

  // Helper: compact structural docking collar flush against the real -X connector wall (-hw)
  const addWestNeck = (depthX = 2.6, halfZ = 2.9, h = 2.2) => {
    addChamferPrism(extrudeGroup, depthX / 2, halfZ, 0, h, 0.35, fillBase, primaryPts, detailPts, {
      cx: -hw + depthX / 2 + 0.12,
    });
  };

  switch (def.id) {
    case 'BPO_StationArmour_01':
    case 'BPO_StationArmour_01B': {
      // True-to-game 16x16m upper roof armour cap (01) vs ceiling-hung belly armour cap (01B, derived via blockBoundsM)
      const isBottomMirror = getModuleFloorShift(def) > 0;
      roofHeight = addStationArmourCap(
        extrudeGroup,
        hw,
        hd,
        isBottomMirror,
        fillBase,
        fillUpper,
        primaryPts,
        detailPts
      );
      break;
    }

    case 'BPO_StationTurretBlock_01': {
      // Binary real SM2_StationTurret_01: 12.44x9.46x9.25m + symmetric DORSAL (top) AND VENTRAL (inverted bottom) twin-barrel plasma turrets!
      roofHeight = 8.2;
      addWestNeck(2.6, 3.2, 2.8);
      // Central armored gun-pod chassis docked to -X (extends from y=-2.2 to +3.6)
      addChamferPrism(extrudeGroup, 4.6, 4.1, -2.2, 3.6, 1.25, fillBase, primaryPts, detailPts, {
        cx: -2.0,
      });

      // Dorsal (upper) rotating turret assembly + long twin barrels (+X)
      addPolyDrum(extrudeGroup, 3.2, 2.75, 8, 3.6, 5.2, Math.PI / 8, fillBase, primaryPts, detailPts, {
        cx: -1.6,
        ribCount: 8,
      });
      addChamferPrism(extrudeGroup, 2.1, 2.35, 5.2, 7.1, 0.55, fillUpper, primaryPts, detailPts, { cx: -1.6 });
      addPolyDrum(extrudeGroup, 1.25, 0.95, 8, 7.1, roofHeight, Math.PI / 8, fillBase, primaryPts, detailPts, {
        cx: -1.8,
        ribCount: 4,
      });
      addRectBlock(extrudeGroup, 3.1, -0.98, 3.9, 0.36, 5.75, 6.55, fillUpper, primaryPts, detailPts);
      addRectBlock(extrudeGroup, 3.1, 0.98, 3.9, 0.36, 5.75, 6.55, fillUpper, primaryPts, detailPts);

      // Ventral (lower inverted) symmetric turret assembly + twin barrels (+X)
      addPolyDrum(extrudeGroup, 2.75, 3.2, 8, -3.8, -2.2, Math.PI / 8, fillBase, primaryPts, detailPts, {
        cx: -1.6,
        ribCount: 8,
      });
      addChamferPrism(extrudeGroup, 2.1, 2.35, -5.7, -3.8, 0.55, fillUpper, primaryPts, detailPts, { cx: -1.6 });
      addPolyDrum(extrudeGroup, 0.95, 1.25, 8, -6.5, -5.7, Math.PI / 8, fillBase, primaryPts, detailPts, {
        cx: -1.8,
        ribCount: 4,
      });
      addRectBlock(extrudeGroup, 3.1, -0.98, 3.9, 0.36, -5.15, -4.35, fillUpper, primaryPts, detailPts);
      addRectBlock(extrudeGroup, 3.1, 0.98, 3.9, 0.36, -5.15, -4.35, fillUpper, primaryPts, detailPts);
      break;
    }

    case 'BPO_CommandModule': {
      // Binary real SM2_CommandModule_Ext: 14.09x12.18x10.97m (Z in [-2.65..+8.32]), panoramic wrap-around bridge glass & central 3.17m holotable!
      roofHeight = 10.4;
      addWestNeck(2.2, 3.8, 2.8);
      // Underside hull keel (-2.4..0)
      addChamferPrism(extrudeGroup, 5.2, 4.6, -2.4, 0, 1.5, fillBase, primaryPts, detailPts, { cx: -1.2 });
      // Main armored bridge hull (0..3.6)
      addChamferPrism(extrudeGroup, 6.5, 5.75, 0, 3.6, 1.9, fillBase, primaryPts, detailPts, { cx: -0.9 });
      // Wrap-around panoramic glass command deck (3.6..5.8)
      addChamferPrism(extrudeGroup, 5.1, 5.65, 3.6, 5.8, 1.7, fillUpper, primaryPts, detailPts, { cx: 0.5 });
      for (const gz of [-3.2, -1.6, 0, 1.6, 3.2]) {
        pushSeg(detailPts, 5.6, gz, 5.6, gz, 3.6, 5.8);
      }
      // Sculpted dorsal CIC crown (5.8..8.3)
      addChamferPrism(extrudeGroup, 4.2, 4.1, 5.8, 8.3, 1.25, fillBase, primaryPts, detailPts, { cx: -1.4 });
      // Central 3.17x3.17m Holotable marker on crown for crisp 2D/3D bridge identity
      pushPolygon(detailPts, 1.65, 8, 8.34, Math.PI / 8, -0.8, 0);
      // Twin slender orbital comms antennae spires
      pushSeg(primaryPts, -2.8, -1.4, -2.8, -1.4, 8.3, roofHeight);
      pushSeg(primaryPts, -2.8, 1.4, -2.8, 1.4, 8.3, roofHeight - 0.8);
      break;
    }

    case 'BPO_ScannerModule': {
      // Shares 14.09x12.18m command-chassis base with underside keel + dorsal parabolic deep-space radar array for unmistakable CAD separation
      roofHeight = 10.8;
      addWestNeck(2.2, 3.4, 2.6);
      addChamferPrism(extrudeGroup, 5.0, 4.4, -2.2, 0, 1.4, fillBase, primaryPts, detailPts, { cx: -1.3 });
      addChamferPrism(extrudeGroup, 6.1, 5.3, 0, 3.6, 1.8, fillBase, primaryPts, detailPts, { cx: -1.0 });
      addChamferPrism(extrudeGroup, 4.5, 4.8, 3.6, 5.8, 1.5, fillUpper, primaryPts, detailPts, { cx: 0.2 });
      // Raised rotary sensor pedestal + large parabolic radar dish (6.0..8.8)
      addPolyDrum(extrudeGroup, 1.9, 4.35, 16, 5.8, 8.5, 0, fillUpper, primaryPts, detailPts, {
        cx: 0.6,
        ribCount: 8,
      });
      // Receiver tripod & deep-space emitter spire
      pushSeg(primaryPts, 0.6, 0, 0.6, 0, 8.5, roofHeight);
      for (const [ox, oz] of [
        [-2.7, 0],
        [2.7, 0],
        [0, -2.7],
        [0, 2.7],
      ]) {
        pushSeg(detailPts, 0.6 + ox, oz, 0.6, 0, 8.5, roofHeight - 0.25);
      }
      break;
    }

    case 'BPO_MiningDroneBayBlock':
    case 'BPO_MiningDroneBayBlock_2': {
      // Binary real SM2_DroneBay_01 = 15.98x14.7x7.23m (2 sloped roof hatches); _02 = 21.98x14.7x7.23m (+6m forward extension, 4 hatches in 2x2!)
      const mk2 = def.id.endsWith('_2');
      roofHeight = 6.9;
      const bodyHalfX = mk2 ? 10.75 : 7.75;
      const bodyCx = mk2 ? 2.85 : -0.05;
      const bodyHalfZ = 7.05;

      // Full-width armored drone hangar hull (y in [-0.6..+4.2])
      addChamferPrism(extrudeGroup, bodyHalfX, bodyHalfZ, -0.6, 4.2, 1.35, fillBase, primaryPts, detailPts, {
        cx: bodyCx,
      });
      // Sloped upper launch deck superstructure (y in [4.2..6.5])
      addChamferPrism(extrudeGroup, bodyHalfX - 1.6, bodyHalfZ - 1.0, 4.2, 6.5, 1.15, fillUpper, primaryPts, detailPts, {
        cx: bodyCx - 0.6,
      });
      // Forward panoramic bay control glass prow (+X)
      const prowX = bodyCx + bodyHalfX;
      for (const gz of [-4.2, -2.1, 0, 2.1, 4.2]) {
        pushSeg(detailPts, prowX + 0.02, gz, prowX + 0.02, gz, 0.8, 3.8);
      }
      pushSeg(primaryPts, prowX + 0.02, -5.2, prowX + 0.02, 5.2, 3.8, 3.8);
      pushSeg(primaryPts, prowX + 0.02, -5.2, prowX + 0.02, 5.2, 0.8, 0.8);

      // Sloped dorsal drone launch hatches (Mk.1: 2 bays at x=0; Mk.2: 4 bays in 2x2 at x=-0.2 & +5.8, z=±4.15)
      const hatchXs = mk2 ? [-0.2, 5.8] : [0.2];
      for (const hxPos of hatchXs) {
        for (const sz of [-1, 1]) {
          addChamferPrism(extrudeGroup, 1.45, 1.4, 6.5, roofHeight, 0.22, fillBase, primaryPts, detailPts, {
            cx: hxPos,
            cz: sz * 4.15,
          });
          pushChevron(detailPts, hxPos, sz * 4.15, 1.45, roofHeight + 0.03);
        }
      }
      break;
    }

    case 'BPO_Dock': {
      // Binary real SM2_Dock_01_Ext: 16.0x11.16x7.21m (Z in [-2.68..+4.52]): streamlined 16m docking tunnel + forward airlock ring + guide fins
      roofHeight = 4.65;
      // Underside hull keel (-2.6..0)
      addChamferPrism(extrudeGroup, 7.6, 4.4, -2.6, 0, 1.1, fillBase, primaryPts, detailPts);
      // Streamlined main docking corridor spanning full 16m length (-7.9..+7.3)
      addChamferPrism(extrudeGroup, 7.6, 5.35, 0, 3.6, 1.35, fillBase, primaryPts, detailPts, { cx: -0.25 });
      // Upper ribbed corridor canopy (3.6..4.65)
      addChamferPrism(extrudeGroup, 6.2, 3.5, 3.6, roofHeight, 0.9, fillUpper, primaryPts, detailPts, { cx: -0.6 });
      // Structural hull ribs along corridor
      for (const rx of [-4.5, -1.5, 1.5, 4.2]) {
        pushSeg(detailPts, rx, -5.36, rx, -3.5, 3.6, roofHeight);
        pushSeg(detailPts, rx, 5.36, rx, 3.5, 3.6, roofHeight);
      }
      // Forward circular docking airlock collar + twin approach guide clamps (+X)
      addPolyDrum(extrudeGroup, 2.25, 2.05, 12, 0.6, 3.9, 0, fillUpper, primaryPts, detailPts, {
        cx: 6.5,
        ribCount: 6,
      });
      addRectBlock(extrudeGroup, 6.9, -3.3, 1.0, 0.45, 0.8, 3.2, fillUpper, primaryPts, detailPts);
      addRectBlock(extrudeGroup, 6.9, 3.3, 1.0, 0.45, 0.8, 3.2, fillUpper, primaryPts, detailPts);
      break;
    }

    case 'BPO_SolarPanelBlock': {
      // Binary real SM2_SolarPanels_02 (Mk.1, 1x1x1): 16.0 x 14.69 x 3.85m — LOW HORIZONTAL twin photovoltaic wings!
      roofHeight = 3.15;
      const wingY = 1.95;
      // Central X structural truss spine connecting W (-8) and E (+8)
      addChamferPrism(extrudeGroup, hw - 0.12, 1.25, -0.65, 2.25, 0.25, fillBase, primaryPts, detailPts);
      // Dorsal spine ridge
      addRectBlock(extrudeGroup, 0, 0, hw - 0.6, 0.55, 2.25, roofHeight, fillUpper, primaryPts, detailPts);

      // Wide horizontal cantilevered photovoltaic wings on -Z and +Z (total lateral span 14.5m!)
      const wingSpanX = lw - 1.9;
      const wingDepthZ = 5.35;
      const wingOffsetZ = 1.9 + wingDepthZ / 2;
      for (const sz of [-1, 1]) {
        // Outrigger struts connecting central spine to horizontal wing
        for (const sx of [-4.2, 0, 4.2]) {
          pushSeg(detailPts, sx, sz * 1.25, sx, sz * 1.92, 1.35, wingY);
        }
        // Thin horizontal photovoltaic wing slab
        addRectBlock(extrudeGroup, 0, sz * wingOffsetZ, wingSpanX / 2, wingDepthZ / 2, wingY - 0.16, wingY + 0.16, fillUpper, primaryPts, detailPts);
        // Fine PV cell sub-grid
        for (let c = 1; c < 4; c++) {
          const lx = -wingSpanX / 2 + (wingSpanX * c) / 4;
          pushSeg(detailPts, lx, sz * (wingOffsetZ - wingDepthZ / 2), lx, sz * (wingOffsetZ + wingDepthZ / 2), wingY + 0.18);
        }
        pushSeg(detailPts, -wingSpanX / 2, sz * wingOffsetZ, wingSpanX / 2, sz * wingOffsetZ, wingY + 0.18);
      }
      break;
    }

    case 'BPO_SolarPanelBlock_02': {
      // Binary real SM2_SolarPanels_01 (Mk.2, 1x1x2): 16.0 x 6.71 x 23.93m (Z in [-10.7..+13.2])!
      // RAZOR-THIN, SKY-PIERCING VERTICAL GIANT SAIL cutting straight through top AND bottom!
      const sailTopY = 13.2;
      const sailBotY = -10.6;
      roofHeight = sailTopY + 0.25;

      // Slim central X structural spine (-8..+8)
      addChamferPrism(extrudeGroup, hw - 0.12, 1.15, -0.7, 2.2, 0.25, fillBase, primaryPts, detailPts);
      // Narrow ±3.25m lateral stabilizer outriggers (real width 6.71m) with tension cables up & down to the vertical mast!
      addChamferPrism(extrudeGroup, 1.15, 3.25, 0.05, 1.45, 0.3, fillBase, primaryPts, detailPts);
      for (const sz of [-1, 1]) {
        pushSeg(detailPts, 0, sz * 3.15, 0, sz * 0.65, 1.45, 7.8);
        pushSeg(detailPts, 0, sz * 3.15, 0, sz * 0.65, 0.05, -5.8);
        pushSeg(detailPts, -0.7, sz * 3.0, -5.8, sz * 0.24, 1.45, 5.2);
        pushSeg(detailPts, 0.7, sz * 3.0, 5.8, sz * 0.24, 1.45, 5.2);
      }

      // Central reinforced vertical keel mast piercing from -10.6m to +13.2m
      addRectBlock(extrudeGroup, 0, 0, 0.62, 0.68, sailBotY, sailTopY, fillBase, primaryPts, detailPts, true);

      // Twin razor-thin (0.44m thick!) upper & lower vertical photovoltaic sail blades flanking the mast
      addVerticalSailBlade(extrudeGroup, -7.45, -0.72, 0, 0.22, 2.25, sailTopY, fillUpper, primaryPts, detailPts, 3, 5);
      addVerticalSailBlade(extrudeGroup, 0.72, 7.45, 0, 0.22, 2.25, sailTopY, fillUpper, primaryPts, detailPts, 3, 5);
      addVerticalSailBlade(extrudeGroup, -7.45, -0.72, 0, 0.22, sailBotY, -0.75, fillUpper, primaryPts, detailPts, 3, 4);
      addVerticalSailBlade(extrudeGroup, 0.72, 7.45, 0, 0.22, sailBotY, -0.75, fillUpper, primaryPts, detailPts, 3, 4);
      break;
    }

    case 'BPO_SolarPanelBlock_03': {
      // Binary real SM2_SolarPanels_03 (Mk.3, 2x1x2): 32.0 x 6.71 x 37.74m (Z in [-17.6..+20.1])!
      // COLOSSAL 32m-WIDE, 37.7m-TALL DUAL-BAY RAZOR-THIN VERTICAL GIANT SAIL!
      const sailTopY = 20.0;
      const sailBotY = -17.5;
      roofHeight = sailTopY + 0.35;

      // Full 32m X structural spine (-16..+16)
      addChamferPrism(extrudeGroup, hw - 0.12, 1.25, -0.8, 2.4, 0.28, fillBase, primaryPts, detailPts);

      // Twin pairs of narrow ±3.3m lateral stabilizer outriggers at x = -8 and x = +8 (real width 6.71m)
      for (const ox of [-8.0, 8.0]) {
        addChamferPrism(extrudeGroup, 1.25, 3.3, 0.0, 1.6, 0.32, fillBase, primaryPts, detailPts, { cx: ox });
        for (const sz of [-1, 1]) {
          pushSeg(detailPts, ox, sz * 3.2, ox, sz * 0.26, 1.6, 12.2);
          pushSeg(detailPts, ox, sz * 3.2, ox, sz * 0.26, 0.0, -9.8);
          pushSeg(detailPts, ox, sz * 3.2, 0, sz * 0.72, 1.6, 14.5);
          pushSeg(detailPts, ox, sz * 3.2, 0, sz * 0.72, 0.0, -12.0);
        }
      }

      // Three towering vertical keel masts (center + twin outer frame towers) from -17.5m to +20.0m
      for (const mx of [-15.1, 0, 15.1]) {
        const mHx = mx === 0 ? 0.72 : 0.52;
        const mHz = mx === 0 ? 0.76 : 0.62;
        addRectBlock(extrudeGroup, mx, 0, mHx, mHz, sailBotY, sailTopY, fillBase, primaryPts, detailPts, true);
      }

      // Dual-bay colossal razor-thin (0.48m thick!) upper & lower vertical sail blades!
      addVerticalSailBlade(extrudeGroup, -14.48, -0.82, 0, 0.24, 2.45, sailTopY, fillUpper, primaryPts, detailPts, 5, 7);
      addVerticalSailBlade(extrudeGroup, 0.82, 14.48, 0, 0.24, 2.45, sailTopY, fillUpper, primaryPts, detailPts, 5, 7);
      addVerticalSailBlade(extrudeGroup, -14.48, -0.82, 0, 0.24, sailBotY, -0.85, fillUpper, primaryPts, detailPts, 5, 6);
      addVerticalSailBlade(extrudeGroup, 0.82, 14.48, 0, 0.24, sailBotY, -0.85, fillUpper, primaryPts, detailPts, 5, 6);
      break;
    }

    case 'BPO_DeepSpaceObservatory': {
      // Binary real SM2_DeepSpaceObservatory_Ext: 33.5 x 32.02 x 26.45m (Z in [-3.6..+22.8]), plus 2-story 14.5m tall panoramic -X glass gallery!
      roofHeight = 22.8;
      // 2-story panoramic observation gallery wall along -X (X in [-15.8..-10.1], Z in [-14.8..+14.8], Y in [-0.2..+14.4])
      addChamferPrism(extrudeGroup, 2.85, 14.9, -0.2, 14.4, 0.8, fillBase, primaryPts, detailPts, {
        cx: -13.0,
        verticalToPrimary: true,
      });
      // Vertical panoramic glass mullions along the -X interior-facing gallery facade (x = -10.1)
      for (let gz = -12; gz <= 12; gz += 4) {
        pushSeg(detailPts, -10.1, gz, -10.1, gz, 0.6, 13.8);
      }
      pushSeg(primaryPts, -10.1, -14.4, -10.1, 14.4, 7.2, 7.2);

      // Underside counterweight stabilizer keel (y in [-3.5..0])
      addPolyDrum(extrudeGroup, 8.8, 11.4, 16, -3.5, 0, 0, fillBase, primaryPts, detailPts, {
        cx: 1.8,
        ribCount: 8,
      });
      // Massive lower observatory drum (0..7.4)
      addPolyDrum(extrudeGroup, 13.4, 12.6, 16, 0, 7.4, 0, fillBase, primaryPts, detailPts, {
        cx: 1.8,
        ribCount: 8,
      });
      // Elevated rotating optical turret drum (7.4..15.2)
      addPolyDrum(extrudeGroup, 12.2, 11.0, 16, 7.4, 15.2, 0, fillUpper, primaryPts, detailPts, {
        cx: 1.8,
        ribCount: 8,
      });
      // Towering geodesic observatory dome crown (15.2..22.8)
      addPolyDrum(extrudeGroup, 11.0, 4.2, 16, 15.2, roofHeight, 0, fillBase, primaryPts, detailPts, {
        cx: 1.8,
        ribCount: 8,
      });
      // Prominent deep-space optical telescope barrel protruding outward from the dome slit (+X)
      addRectBlock(extrudeGroup, 10.6, 0, 4.8, 1.75, 14.4, 18.6, fillUpper, primaryPts, detailPts, true);
      pushSeg(primaryPts, 5.8, -1.75, 15.4, -1.75, 16.5, 19.6);
      pushSeg(primaryPts, 5.8, 1.75, 15.4, 1.75, 16.5, 19.6);
      break;
    }

    case 'BPO_ShipyardCore':
    case 'BPO_ShipyardCore_02':
    case 'BPO_ShipyardSide': {
      // Binary real Shipyard heights = 16.0m (Z in [-4.85..+11.15]): tall vertical drydock bulkhead + front glass + BOTH upper gantries & lower keel cradles!
      const isBig = def.id === 'BPO_ShipyardCore_02';
      const isSide = def.id === 'BPO_ShipyardSide';
      const topY = 11.15;
      const botY = -4.65;
      roofHeight = topY + 0.25;

      const spineHalfX = isSide ? 2.4 : 2.5;
      const spineX = -hw + spineHalfX + 0.2;
      // Full 16m-tall drydock bulkhead spine along -X
      addChamferPrism(extrudeGroup, spineHalfX, hd - 0.45, botY, topY, 0.55, fillBase, primaryPts, detailPts, {
        cx: spineX,
        verticalToPrimary: true,
      });
      // Panoramic drydock control window mullions along +X face of the bulkhead
      const glassX = spineX + spineHalfX + 0.04;
      const mullionStep = isBig ? 4.5 : 3.4;
      for (let gz = -hd + 3.0; gz <= hd - 3.0; gz += mullionStep) {
        pushSeg(detailPts, glassX, gz, glassX, gz, 0.4, 6.2);
      }
      pushSeg(primaryPts, glassX, -hd + 1.2, glassX, hd - 1.2, 6.2, 6.2);
      pushSeg(primaryPts, glassX, -hd + 1.2, glassX, hd - 1.2, 0.4, 0.4);

      // Upper overhead gantry arms + symmetric lower keel cradle arms framing the open ship-build space (+X)
      const armReach = isSide ? 4.4 : isBig ? 18.2 : 10.6;
      const armCx = spineX + spineHalfX + armReach / 2;
      const armHalfZ = isBig ? 1.45 : 1.05;
      const zOffsets = isBig ? [-hd + 2.4, 0, hd - 2.4] : [-hd + 2.0, hd - 2.0];
      const tipX = spineX + spineHalfX + armReach - 0.65;

      for (const oz of zOffsets) {
        // Upper overhead gantry beam (9.4..11.15)
        addRectBlock(extrudeGroup, armCx, oz, armReach / 2, armHalfZ, topY - 1.75, topY, fillUpper, primaryPts, detailPts);
        // Lower keel cradle beam (-4.65..-2.95)
        addRectBlock(extrudeGroup, armCx, oz, armReach / 2, armHalfZ, botY, botY + 1.7, fillUpper, primaryPts, detailPts);
        // Outer vertical calibration end-stanchion connecting upper & lower gantry tips
        addRectBlock(extrudeGroup, tipX, oz, 0.65, armHalfZ * 0.85, botY + 1.7, topY - 1.75, fillBase, primaryPts, detailPts, true);
        // Diagonal structural truss gussets at the root
        pushSeg(detailPts, spineX + spineHalfX, oz, spineX + spineHalfX + armReach * 0.45, oz, topY - 4.2, topY - 1.75);
        pushSeg(detailPts, spineX + spineHalfX, oz, spineX + spineHalfX + armReach * 0.45, oz, botY + 4.1, botY + 1.7);
      }
      break;
    }

    default: {
      roofHeight = 3.2;
      addWestNeck(2.6, 2.8, 2.0);
      addChamferPrism(extrudeGroup, hw * 0.58, hd * 0.58, 0, roofHeight, 1.0, fillBase, primaryPts, detailPts);
      break;
    }
  }

  if (primaryPts.length > 0) {
    extrudeGroup.add(
      buildLineSegments(
        primaryPts,
        primaryColor,
        isGhost ? opacity * 0.94 : opacity,
        isSelected ? 1.55 : 1.28,
        'primary'
      )
    );
  }
  if (detailPts.length > 0) {
    extrudeGroup.add(
      buildLineSegments(
        detailPts,
        isGhost ? ghostTint : isSelected ? palette.linePrimary : palette.lineDetail,
        isGhost ? opacity * 0.62 : opacity,
        0.85,
        'detail'
      )
    );
  }

  root.add(extrudeGroup);
  return { root, extrudeGroup, roofHeight };
}

/**
 * Sculpted architectural 3D/2D gantry & freighter berth structure for BPO_Dock_2 (Industrial Dock 3x2).
 * Local centered space: X in [-24, +24], Z in [-16, +16].
 * - West 1x2 indoor factory bay: X in [-24, -8] (handled by slab + floor surface)
 * - East 2x2 open freighter hangar: X in [-8, +24] (twin overhead gantry arms, clamp pylons, cargo bulkhead, berth centerline)
 */
export function buildIndustrialDockGantryArt(
  mod: PlacedModule,
  def: StationModuleDef,
  baseY: number,
  opacity: number,
  isSelected: boolean,
  palette: CadThemePalette = CAD_THEMES['platinum-gold'],
  ghostTint?: number
): MachineLineArtResult {
  const root = new THREE.Group();
  const [cx, cz] = getModuleCenterM(mod, def);
  const isGhost = ghostTint !== undefined;

  const extrudeGroup = new THREE.Group();
  extrudeGroup.position.set(cx, baseY, cz);
  extrudeGroup.rotation.y = -mod.rotation * (Math.PI / 2);

  const fillBase = createOcclusionMat(
    isGhost ? ghostTint : isSelected ? palette.bodyFillSelected : palette.bodyFill,
    opacity,
    isGhost
  );
  const fillUpper = createOcclusionMat(
    isGhost ? ghostTint : isSelected ? palette.bodyFillSelected : palette.bodyFillUpper,
    opacity,
    isGhost
  );

  const primaryPts: number[] = [];
  const detailPts: number[] = [];
  const roofHeight = 5.4;

  // Bulkhead docking interface collar separating west indoor bay (x=-8) from east open freighter berth
  addRectBlock(extrudeGroup, -7.8, -11.4, 1.1, 3.6, 0, 4.4, fillBase, primaryPts, detailPts);
  addRectBlock(extrudeGroup, -7.8, 11.4, 1.1, 3.6, 0, 4.4, fillBase, primaryPts, detailPts);
  // Central airlock transfer threshold along x=-8
  addRectBlock(extrudeGroup, -7.8, 0, 0.85, 5.2, 0, 1.6, fillUpper, primaryPts, detailPts);

  // Twin long open freighter docking gantry arms extending into open space (+X from -8 to +23.4)
  for (const sz of [-1, 1]) {
    const armZ = sz * 13.6;
    // Lower docking pier deck
    addRectBlock(extrudeGroup, 7.7, armZ, 15.6, 1.75, 0, 1.4, fillBase, primaryPts, detailPts);
    // Raised overhead gantry girder beam
    addRectBlock(extrudeGroup, 6.2, armZ, 13.4, 1.05, 1.4, roofHeight, fillUpper, primaryPts, detailPts);
    // Forward mooring clamp head at x=+21.2
    addChamferPrism(extrudeGroup, 2.0, 2.1, 0, 3.8, 0.65, fillUpper, primaryPts, detailPts, {
      cx: 21.2,
      cz: armZ - sz * 0.3,
    });
    // Mid-berth cargo transfer stanchion ribs
    for (const bx of [-1.5, 6.5, 14.5]) {
      pushSeg(detailPts, bx, armZ - sz * 1.75, bx, armZ - sz * 3.1, 1.35, 1.35);
      pushSeg(detailPts, bx, armZ - sz * 3.1, bx, armZ - sz * 3.1, 0.2, 1.35);
    }
  }

  // Subtle open ship-berth approach centerline & docking stop bar inside the empty 32x24m freighter bay
  pushSeg(detailPts, -5.0, 0, 21.5, 0, 0.08, 0.08);
  pushSeg(detailPts, -5.0, -5.5, -5.0, 5.5, 0.08, 0.08);
  pushSeg(detailPts, 7.5, -3.2, 7.5, 3.2, 0.08, 0.08);
  pushChevron(detailPts, 15.5, 0, 3.2, 0.08);
  pushChevron(detailPts, 2.5, 0, 3.2, 0.08);

  const primaryColor = isGhost ? ghostTint : isSelected ? palette.lineSelected : palette.linePrimary;
  if (primaryPts.length > 0) {
    extrudeGroup.add(
      buildLineSegments(primaryPts, primaryColor, isGhost ? opacity * 0.94 : opacity, isSelected ? 1.55 : 1.28, 'primary')
    );
  }
  if (detailPts.length > 0) {
    extrudeGroup.add(
      buildLineSegments(
        detailPts,
        isGhost ? ghostTint : isSelected ? palette.linePrimary : palette.lineDetail,
        isGhost ? opacity * 0.65 : opacity,
        0.9,
        'detail'
      )
    );
  }

  root.add(extrudeGroup);
  return { root, extrudeGroup, roofHeight };
}

export { buildShipModuleArt } from './ship-line-art';
