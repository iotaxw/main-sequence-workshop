import * as THREE from 'three';
import { getBuildableDef } from './../core/catalog';
import {
  findBuildingAtCell,
  getBuildingCenterM,
  getBuildingSizeCells,
  getBuildingWorldPorts,
  getModuleCenterM,
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

function pushRect(out: number[], hw: number, hd: number, y = 0, chamfer = 0): void {
  pushLoop(out, getChamferLoop(hw, hd, chamfer), y);
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
  lodTier: 'primary' | 'detail' = 'primary'
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
  detailPts: number[]
): void {
  addChamferPrism(target, hx, hz, y0, y1, 0, fillMat, primaryPts, detailPts, { cx, cz });
}

/**
 * Adds a sculpted tapered architectural wedge / sloped armour plate.
 */
function addSlopedArmourPlate(
  target: THREE.Group,
  hw: number,
  hd: number,
  hBack: number,
  hFront: number,
  mirrored: boolean,
  fillMat: THREE.Material,
  primaryPts: number[],
  detailPts: number[]
): void {
  // Base trapezoid in XZ (sloping from back edge -X to narrower beveled nose +X, mirrored across Z for 01B)
  const s = mirrored ? -1 : 1;
  const xBack = -hw;
  const xFront = hw;
  const zOuter = s * hd;
  const zInner = -s * hd;
  const zTaper = s * (hd * 0.25);

  const b0: [number, number, number] = [xBack, 0, zInner];
  const b1: [number, number, number] = [xFront, 0, zInner];
  const b2: [number, number, number] = [xFront, 0, zTaper];
  const b3: [number, number, number] = [xBack, 0, zOuter];

  const t0: [number, number, number] = [xBack, hBack, zInner];
  const t1: [number, number, number] = [xFront, hFront, zInner];
  const t2: [number, number, number] = [xFront, hFront * 0.65, zTaper];
  const t3: [number, number, number] = [xBack, hBack * 0.72, zOuter];

  // Build crisp 6-face matte occlusion prism via BufferGeometry
  const verts = [
    // Top face (two tris)
    ...t0, ...t1, ...t2, ...t0, ...t2, ...t3,
    // Bottom face
    ...b0, ...b2, ...b1, ...b0, ...b3, ...b2,
    // Side walls
    ...b0, ...b1, ...t1, ...b0, ...t1, ...t0,
    ...b1, ...b2, ...t2, ...b1, ...t2, ...t1,
    ...b2, ...b3, ...t3, ...b2, ...t3, ...t2,
    ...b3, ...b0, ...t0, ...b3, ...t0, ...t3,
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.computeVertexNormals();
  target.add(new THREE.Mesh(geo, fillMat));

  // Primary silhouette edges
  const topLoop = [t0, t1, t2, t3];
  const botLoop = [b0, b1, b2, b3];
  for (let i = 0; i < 4; i++) {
    const a = topLoop[i];
    const b = topLoop[(i + 1) % 4];
    pushSeg(primaryPts, a[0], a[2], b[0], b[2], a[1], b[1]);
    const ba = botLoop[i];
    const bb = botLoop[(i + 1) % 4];
    pushSeg(detailPts, ba[0], ba[2], bb[0], bb[2], ba[1], bb[1]);
    pushSeg(detailPts, ba[0], ba[2], a[0], a[2], ba[1], a[1]);
  }
  // Armored rib creases along the sloped deck
  const midZ1 = (zInner + zOuter) * 0.5;
  const midZ2 = (zInner + zTaper) * 0.5;
  const midY1 = (hBack + hBack * 0.72) * 0.5;
  const midY2 = (hFront + hFront * 0.65) * 0.5;
  pushSeg(detailPts, xBack, midZ1, xFront, midZ2, midY1 + 0.02, midY2 + 0.02);
  pushSeg(
    detailPts,
    (xBack + xFront) * 0.5,
    zInner,
    (xBack + xFront) * 0.5,
    (zOuter + zTaper) * 0.5,
    (hBack + hFront) * 0.5 + 0.02,
    (hBack * 0.72 + hFront * 0.65) * 0.5 + 0.02
  );
}

/**
 * Flush elongated rectangular port marker hugging the building perimeter edge.
 */
function buildFlushPortMarker(
  wx: number,
  y: number,
  wz: number,
  side: 'N' | 'E' | 'S' | 'W',
  enabled: boolean,
  opacity: number,
  palette: CadThemePalette
): THREE.Object3D {
  const pts: number[] = [];
  const along = 0.27;
  const thick = 0.068;
  let offX = 0;
  let offZ = 0;
  let hx = along;
  let hz = thick;

  if (side === 'N') {
    offZ = 0.08;
  } else if (side === 'S') {
    offZ = -0.08;
  } else if (side === 'E') {
    offX = -0.08;
    hx = thick;
    hz = along;
  } else {
    offX = 0.08;
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
    1.05,
    'detail'
  );
  segs.position.set(wx + offX, y, wz + offZ);
  return segs;
}

/** Check whether a neighbor cell outputs logistics flow into `(targetX, targetY)` */
function doesNeighborFeedCell(
  doc: BlueprintDocument,
  nbX: number,
  nbY: number,
  floor: number,
  dxFromTarget: number,
  dyFromTarget: number
): boolean {
  const nb = findBuildingAtCell(doc, nbX, nbY, floor);
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
  palette: CadThemePalette = CAD_THEMES['platinum-gold']
): THREE.Group {
  const group = new THREE.Group();
  const cx = b.x + 0.5;
  const cz = b.y + 0.5;
  const y = baseY + 0.04;

  const [outDx, outDy] = rotationToDelta(b.rotation);

  // 1. Check straight-behind FIRST so straight runs are never hijacked by side merges!
  let inDir: [number, number] | null = null;
  if (doesNeighborFeedCell(doc, b.x - outDx, b.y - outDy, b.floor, -outDx, -outDy)) {
    inDir = [outDx, outDy];
  } else {
    // 2. Otherwise inspect the two perpendicular sides for a clean L-turn
    const perpDirs: Array<[number, number]> = [
      [-outDy, outDx],
      [outDy, -outDx],
    ];
    for (const [dx, dy] of perpDirs) {
      if (doesNeighborFeedCell(doc, b.x + dx, b.y + dy, b.floor, dx, dy)) {
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

  const railLines = buildLineSegments(railPts, railColor, opacity, isSelected ? 1.25 : 1.05, 'primary');
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
    'detail'
  );
  chevLines.position.set(cx, y + 0.015, cz);
  chevLines.rotation.y = -b.rotation * (Math.PI / 2);
  group.add(chevLines);

  return group;
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

  const primaryColor = isGhost
    ? ghostTint
    : isSelected
      ? palette.lineSelected
      : def.kind === 'research'
        ? palette.researchTint
        : def.kind === 'reactor'
          ? palette.powerTint
          : palette.linePrimary;

  switch (def.id) {
    case 'DAT_Refinery': {
      roofHeight = 1.48;
      addChamferPrism(extrudeGroup, hw, hd, 0, 0.54, 0.34, fillBase, primaryPts, detailPts);
      addPolyDrum(extrudeGroup, minH * 0.62, minH * 0.54, 16, 0.54, 1.26, 0, fillUpper, primaryPts, detailPts, {
        ribCount: 8,
      });
      addPolyDrum(extrudeGroup, minH * 0.32, minH * 0.28, 8, 1.26, roofHeight, Math.PI / 8, fillBase, primaryPts, detailPts, {
        ribCount: 4,
      });
      const r0 = minH * 0.56;
      const r1 = minH * 0.92;
      for (let i = 0; i < 4; i++) {
        const a = Math.PI / 4 + (i * Math.PI) / 2;
        pushSeg(detailPts, Math.cos(a) * r1, Math.sin(a) * r1, Math.cos(a) * r0, Math.sin(a) * r0, 0.54, 1.2);
      }
      break;
    }

    case 'DAT_Assembler': {
      roofHeight = 1.85;
      addChamferPrism(extrudeGroup, hw, hd, 0, 0.72, 0.38, fillBase, primaryPts, detailPts);
      addChamferPrism(extrudeGroup, hw * 0.72, hd * 0.72, 0.72, 1.38, 0.18, fillUpper, primaryPts, detailPts);
      addPolyDrum(extrudeGroup, minH * 0.36, minH * 0.34, 4, 1.38, roofHeight, 0, fillBase, primaryPts, detailPts, {
        ribCount: 4,
      });
      pushSeg(detailPts, -hw * 0.72, 0, -minH * 0.36, 0, 1.39, 1.39);
      pushSeg(detailPts, minH * 0.36, 0, hw * 0.72, 0, 1.39, 1.39);
      pushSeg(detailPts, 0, -hd * 0.72, 0, -minH * 0.36, 1.39, 1.39);
      pushSeg(detailPts, 0, minH * 0.36, 0, hd * 0.72, 1.39, 1.39);
      break;
    }

    case 'DAT_AdvancedAssembler': {
      roofHeight = 2.65;
      addChamferPrism(extrudeGroup, hw, hd, 0, 0.92, 0.58, fillBase, primaryPts, detailPts);
      addChamferPrism(extrudeGroup, hw * 0.82, hd * 0.82, 0.92, 1.78, 0.32, fillUpper, primaryPts, detailPts);
      addPolyDrum(extrudeGroup, minH * 0.44, minH * 0.36, 4, 1.78, 2.38, 0, fillBase, primaryPts, detailPts, {
        ribCount: 4,
      });
      addChamferPrism(extrudeGroup, minH * 0.18, minH * 0.18, 2.38, roofHeight, 0, fillUpper, primaryPts, detailPts);
      pushSeg(detailPts, -hw * 0.82, 0, hw * 0.82, 0, 1.79, 1.79);
      pushSeg(detailPts, 0, -hd * 0.82, 0, hd * 0.82, 1.79, 1.79);
      break;
    }

    case 'DAT_EnrichmentChamber': {
      roofHeight = 2.75;
      addChamferPrism(extrudeGroup, hw, hd, 0, 0.78, 0.72, fillBase, primaryPts, detailPts);
      addPolyDrum(extrudeGroup, minH * 0.78, minH * 0.74, 24, 0.78, 1.56, 0, fillUpper, primaryPts, detailPts, {
        ribCount: 8,
      });
      addPolyDrum(extrudeGroup, minH * 0.48, minH * 0.44, 16, 1.56, 2.28, 0, fillBase, primaryPts, detailPts, {
        ribCount: 8,
      });
      addPolyDrum(extrudeGroup, minH * 0.22, minH * 0.18, 12, 2.28, roofHeight, 0, fillUpper, primaryPts, detailPts, {
        ribCount: 4,
      });
      break;
    }

    case 'DAT_Supercomputer': {
      roofHeight = 2.32;
      addChamferPrism(extrudeGroup, hw, hd, 0, 0.48, 0.38, fillBase, primaryPts, detailPts);
      const bladeCount = 5;
      const spanX = hw * 1.48;
      for (let i = 0; i < bladeCount; i++) {
        const x = -spanX / 2 + (spanX * i) / (bladeCount - 1);
        addRectBlock(extrudeGroup, x, 0, 0.2, hd * 0.72, 0.48, 2.08, fillUpper, primaryPts, detailPts);
      }
      addRectBlock(extrudeGroup, 0, 0, hw * 0.86, 0.26, 2.08, roofHeight, fillBase, primaryPts, detailPts);
      break;
    }

    case 'DAT_GrowthChamber': {
      roofHeight = 2.45;
      addChamferPrism(extrudeGroup, hw, hd, 0, 0.68, 0.68, fillBase, primaryPts, detailPts);
      addPolyDrum(extrudeGroup, minH * 0.76, minH * 0.7, 6, 0.68, 1.88, Math.PI / 6, fillUpper, primaryPts, detailPts, {
        ribCount: 6,
      });
      addPolyDrum(extrudeGroup, minH * 0.7, minH * 0.24, 6, 1.88, roofHeight, Math.PI / 6, fillBase, primaryPts, detailPts, {
        ribCount: 6,
      });
      break;
    }

    case 'DAT_RelicSynthesizer': {
      roofHeight = 2.85;
      addChamferPrism(extrudeGroup, hw, hd, 0, 0.82, 0.9, fillBase, primaryPts, detailPts);
      addPolyDrum(extrudeGroup, minH * 0.68, minH * 0.6, 4, 0.82, 1.65, 0, fillUpper, primaryPts, detailPts, {
        ribCount: 4,
      });
      const pOff = minH * 0.64;
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          addRectBlock(extrudeGroup, sx * pOff, sz * pOff, 0.42, 0.42, 0.82, 2.38, fillBase, primaryPts, detailPts);
        }
      }
      addPolyDrum(extrudeGroup, minH * 0.24, minH * 0.14, 8, 1.65, roofHeight, Math.PI / 8, fillUpper, primaryPts, detailPts, {
        ribCount: 4,
      });
      break;
    }

    case 'DAT_ReactorMachine': {
      roofHeight = 2.55;
      addChamferPrism(extrudeGroup, hw, hd, 0, 0.88, 0.62, fillBase, primaryPts, detailPts);
      addPolyDrum(extrudeGroup, minH * 0.44, minH * 0.36, 12, 0.88, roofHeight, 0, fillUpper, primaryPts, detailPts, {
        ribCount: 6,
      });
      for (let i = 0; i < 3; i++) {
        const a = (i * Math.PI * 2) / 3 - Math.PI / 2;
        const rIn = minH * 0.44;
        const rOut = minH * 0.88;
        pushSeg(primaryPts, Math.cos(a) * rIn, Math.sin(a) * rIn, Math.cos(a) * rOut, Math.sin(a) * rOut, 2.1, 0.88);
        pushSeg(detailPts, Math.cos(a) * rIn, Math.sin(a) * rIn, Math.cos(a) * rOut, Math.sin(a) * rOut, 0.88, 0.88);
        pushSeg(detailPts, Math.cos(a) * rOut, Math.sin(a) * rOut, Math.cos(a) * rOut, Math.sin(a) * rOut, 0.88, 1.35);
      }
      break;
    }

    case 'DAT_Container':
    case 'DAT_Container_2': {
      const isLarge = def.id === 'DAT_Container_2';
      roofHeight = isLarge ? 1.68 : 1.08;
      addChamferPrism(extrudeGroup, hw, hd, 0, roofHeight * 0.78, isLarge ? 0.28 : 0.16, fillBase, primaryPts, detailPts);
      addChamferPrism(
        extrudeGroup,
        hw * 0.84,
        hd * 0.84,
        roofHeight * 0.78,
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
      roofHeight = 1.48;
      addChamferPrism(extrudeGroup, hw, hd, 0, 0.42, 0.52, fillBase, primaryPts, detailPts);
      addPolyDrum(extrudeGroup, minH * 0.78, minH * 0.72, 20, 0.42, 0.96, 0, fillUpper, primaryPts, detailPts, {
        ribCount: 8,
      });
      addPolyDrum(extrudeGroup, minH * 0.44, minH * 0.38, 16, 0.96, roofHeight, 0, fillBase, primaryPts, detailPts, {
        ribCount: 4,
      });
      break;
    }

    case 'DAT_WorkbenchMachine':
    case 'DAT_Armoury': {
      roofHeight = def.id === 'DAT_Armoury' ? 1.42 : 1.05;
      addChamferPrism(extrudeGroup, hw, hd, 0, roofHeight * 0.65, 0.22, fillBase, primaryPts, detailPts);
      addChamferPrism(extrudeGroup, hw * 0.72, hd * 0.72, roofHeight * 0.65, roofHeight, 0.14, fillUpper, primaryPts, detailPts);
      break;
    }

    default: {
      if (def.kind === 'research') {
        roofHeight = lw >= 9 ? 2.65 : lw >= 5 ? 1.92 : 1.52;
        addChamferPrism(extrudeGroup, hw, hd, 0, roofHeight * 0.42, Math.min(0.45, minH * 0.24), fillBase, primaryPts, detailPts);

        if (def.id === 'DAT_QuantumSciLab') {
          addPolyDrum(extrudeGroup, minH * 0.72, minH * 0.64, 24, roofHeight * 0.42, roofHeight * 0.76, 0, fillUpper, primaryPts, detailPts, {
            ribCount: 8,
          });
          addPolyDrum(extrudeGroup, minH * 0.32, minH * 0.24, 12, roofHeight * 0.76, roofHeight, 0, fillBase, primaryPts, detailPts, {
            ribCount: 6,
          });
        } else if (def.id === 'DAT_AstroSciLab') {
          addPolyDrum(extrudeGroup, minH * 0.76, minH * 0.62, 12, roofHeight * 0.42, roofHeight * 0.78, 0, fillUpper, primaryPts, detailPts, {
            ribCount: 6,
          });
          addPolyDrum(extrudeGroup, minH * 0.62, minH * 0.2, 12, roofHeight * 0.78, roofHeight, 0, fillBase, primaryPts, detailPts, {
            ribCount: 6,
          });
        } else if (def.id === 'DAT_XenoSciLab') {
          addPolyDrum(extrudeGroup, minH * 0.72, minH * 0.62, 6, roofHeight * 0.42, roofHeight * 0.84, Math.PI / 6, fillUpper, primaryPts, detailPts, {
            ribCount: 6,
          });
          addPolyDrum(extrudeGroup, minH * 0.36, minH * 0.22, 3, roofHeight * 0.84, roofHeight, 0, fillBase, primaryPts, detailPts, {
            ribCount: 3,
          });
        } else if (def.id === 'DAT_ElectroSciLab') {
          addPolyDrum(extrudeGroup, minH * 0.74, minH * 0.64, 4, roofHeight * 0.42, roofHeight * 0.84, 0, fillUpper, primaryPts, detailPts, {
            ribCount: 4,
          });
          addPolyDrum(extrudeGroup, minH * 0.26, minH * 0.26, 8, roofHeight * 0.84, roofHeight, 0, fillBase, primaryPts, detailPts, {
            ribCount: 4,
          });
        } else if (def.id === 'DAT_CompSciLab') {
          addChamferPrism(extrudeGroup, hw * 0.62, hd * 0.62, roofHeight * 0.42, roofHeight, 0.14, fillUpper, primaryPts, detailPts);
        } else {
          addPolyDrum(extrudeGroup, minH * 0.68, minH * 0.58, 16, roofHeight * 0.42, roofHeight, 0, fillUpper, primaryPts, detailPts, {
            ribCount: 8,
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
        isSelected ? 1.45 : 1.12,
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

  if (def.configurablePorts) {
    const worldPorts = getBuildingWorldPorts(b, def);
    for (const wp of worldPorts) {
      root.add(
        buildFlushPortMarker(
          wp.worldX,
          floorY + 0.025,
          wp.worldY,
          wp.side,
          wp.enabled,
          isGhost ? opacity * 0.82 : opacity,
          palette
        )
      );
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
  const minH = Math.min(hw, hd);

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
      // Sleek beveled hull fairing wedge (real 4m height, hugging inner corner with generous open space outside)
      const mirrored = def.id === 'BPO_StationArmour_01B';
      roofHeight = 3.4;
      addSlopedArmourPlate(extrudeGroup, hw * 0.88, hd * 0.84, roofHeight, 0.85, mirrored, fillBase, primaryPts, detailPts);
      break;
    }

    case 'BPO_StationTurretBlock_01': {
      // Compact mounted space plasma turret docked at -X: slim collar + compact 7m octagonal mount + tall cupola + long twin barrels!
      roofHeight = 5.4;
      addWestNeck(3.2, 2.8, 2.2);
      // Compact octagonal armored gun mount centered around x = -1.2 (leaves generous open void on N/S/E!)
      addPolyDrum(extrudeGroup, 3.8, 3.3, 8, 0, 2.4, Math.PI / 8, fillBase, primaryPts, detailPts, {
        cx: -1.0,
        ribCount: 8,
      });
      // Elevated turret breach housing
      addChamferPrism(extrudeGroup, 2.3, 2.1, 2.4, 4.4, 0.55, fillUpper, primaryPts, detailPts, { cx: -1.0 });
      addPolyDrum(extrudeGroup, 1.35, 1.05, 8, 4.4, roofHeight, Math.PI / 8, fillBase, primaryPts, detailPts, {
        cx: -1.3,
        ribCount: 4,
      });
      // Long protruding twin plasma barrels extending outward into empty space (+X)
      addRectBlock(extrudeGroup, 3.6, -0.95, 3.4, 0.36, 2.95, 3.65, fillUpper, primaryPts, detailPts);
      addRectBlock(extrudeGroup, 3.6, 0.95, 3.4, 0.36, 2.95, 3.65, fillUpper, primaryPts, detailPts);
      break;
    }

    case 'BPO_CommandModule': {
      // Compact tapered command bridge pod docked at -X (real 4m height, sleek nose + observation deck + dual spires)
      roofHeight = 4.6;
      addWestNeck(2.8, 3.1, 2.1);
      addChamferPrism(extrudeGroup, 3.6, 3.8, 0, 2.5, 1.3, fillBase, primaryPts, detailPts, { cx: -1.6 });
      // Tapered forward bridge prow (+X)
      addChamferPrism(extrudeGroup, 2.1, 2.4, 0.25, 2.9, 0.85, fillUpper, primaryPts, detailPts, { cx: 2.3 });
      // Upper hexagonal CIC crown
      addPolyDrum(extrudeGroup, 2.1, 1.65, 6, 2.5, 3.7, Math.PI / 6, fillUpper, primaryPts, detailPts, {
        cx: -1.5,
        ribCount: 6,
      });
      // Twin slender comms antennae
      pushSeg(primaryPts, -2.3, -1.1, -2.3, -1.1, 3.7, roofHeight);
      pushSeg(primaryPts, -2.3, 1.1, -2.3, 1.1, 3.7, roofHeight - 0.45);
      break;
    }

    case 'BPO_ScannerModule': {
      // Compact -X mount + sleek cantilevered sensor boom + circular parabolic radar dish floating in open space
      roofHeight = 4.9;
      addWestNeck(3.2, 2.5, 1.9);
      // Structural boom arm
      addRectBlock(extrudeGroup, -2.2, 0, 2.6, 1.15, 0.35, 1.65, fillBase, primaryPts, detailPts);
      // Sculpted parabolic dish centered at x = +1.4 (compact ~4.1m radius with crisp dark void around it)
      addPolyDrum(extrudeGroup, 1.8, 4.1, 16, 1.4, 3.4, 0, fillUpper, primaryPts, detailPts, {
        cx: 1.4,
        ribCount: 8,
      });
      // Receiver tripod & emitter needle
      pushSeg(primaryPts, 1.4, 0, 1.4, 0, 3.4, roofHeight);
      pushSeg(detailPts, 1.4 - 2.4, 0, 1.4, 0, 3.4, roofHeight - 0.2);
      pushSeg(detailPts, 1.4 + 2.4, 0, 1.4, 0, 3.4, roofHeight - 0.2);
      pushSeg(detailPts, 1.4, -2.4, 1.4, 0, 3.4, roofHeight - 0.2);
      pushSeg(detailPts, 1.4, 2.4, 1.4, 0, 3.4, roofHeight - 0.2);
      break;
    }

    case 'BPO_MiningDroneBayBlock':
    case 'BPO_MiningDroneBayBlock_2': {
      // Compact docked mining drone bay with open forward (+X) launch apron & twin/quad drone bays (NOT a 16x16 block!)
      const mk2 = def.id.endsWith('_2');
      roofHeight = mk2 ? 4.3 : 3.4;
      addWestNeck(2.4, 3.2, 2.3);
      const bodyHalfX = mk2 ? 4.2 : 3.4;
      const bodyHalfZ = mk2 ? 5.2 : 4.1;
      const bodyCx = -hw + 2.2 + bodyHalfX;
      addChamferPrism(extrudeGroup, bodyHalfX, bodyHalfZ, 0, roofHeight, 0.9, fillBase, primaryPts, detailPts, {
        cx: bodyCx,
      });
      // Twin open forward launch guide rails extending into empty space on +X
      const armCx = bodyCx + bodyHalfX + 1.7;
      addRectBlock(extrudeGroup, armCx, -bodyHalfZ + 0.9, 1.8, 0.65, 0, 1.5, fillUpper, primaryPts, detailPts);
      addRectBlock(extrudeGroup, armCx, bodyHalfZ - 0.9, 1.8, 0.65, 0, 1.5, fillUpper, primaryPts, detailPts);
      // Drone launch hatch divisions on deck
      pushSeg(detailPts, bodyCx, -bodyHalfZ * 0.85, bodyCx, bodyHalfZ * 0.85, roofHeight + 0.02);
      if (mk2) {
        pushSeg(detailPts, bodyCx - bodyHalfX * 0.85, 0, bodyCx + bodyHalfX * 0.85, 0, roofHeight + 0.02);
      }
      break;
    }

    case 'BPO_Dock': {
      // Compact airlock collar on -X + twin slim open ship-docking guide arms cradling dark empty space on +X!
      roofHeight = 3.0;
      addWestNeck(3.2, 3.3, 2.4);
      addPolyDrum(extrudeGroup, 2.6, 2.3, 12, 0.2, roofHeight, 0, fillUpper, primaryPts, detailPts, {
        cx: -3.2,
        ribCount: 6,
      });
      // Open docking clamp arms flanking empty ship berth
      addRectBlock(extrudeGroup, 1.8, -3.4, 3.8, 0.65, 0, 1.8, fillBase, primaryPts, detailPts);
      addRectBlock(extrudeGroup, 1.8, 3.4, 3.8, 0.65, 0, 1.8, fillBase, primaryPts, detailPts);
      // Subtle docking centerline approach marker
      pushSeg(detailPts, -0.4, 0, 6.2, 0, 0.4, 0.4);
      break;
    }

    case 'BPO_SolarPanelBlock':
    case 'BPO_SolarPanelBlock_02':
    case 'BPO_SolarPanelBlock_03': {
      // Slim central structural spine between -X & +X connectors + cantilevered thin photovoltaic wings with real air gaps!
      const tier = def.id.endsWith('03') ? 3 : def.id.endsWith('02') ? 2 : 1;
      roofHeight = tier === 3 ? 5.6 : tier === 2 ? 4.4 : 2.6;
      const wingY = roofHeight * 0.68;
      // Slim central spine along X connecting W (-hw) and E (+hw)
      addChamferPrism(extrudeGroup, hw - 0.15, 1.25, 0, 1.8, 0.25, fillBase, primaryPts, detailPts);

      // Cantilevered photovoltaic wings on North (-Z) and South (+Z) with crisp air gap around the spine
      const wingCountX = tier === 3 ? 2 : 1;
      const wingSpanX = (lw - 2.6) / wingCountX - 0.9;
      const wingDepthZ = tier >= 2 ? hd * 0.68 : hd * 0.56;
      const wingOffsetZ = 1.85 + wingDepthZ / 2;

      for (let ix = 0; ix < wingCountX; ix++) {
        const wx = wingCountX === 1 ? 0 : -hw / 2 + ix * hw;
        for (const sz of [-1, 1]) {
          // Support strut from central spine to wing
          pushSeg(detailPts, wx, sz * 1.25, wx, sz * (1.85 + 0.1), 1.3, wingY);
          // Thin photovoltaic wing slab
          addRectBlock(extrudeGroup, wx, sz * wingOffsetZ, wingSpanX / 2, wingDepthZ / 2, wingY - 0.14, wingY + 0.14, fillUpper, primaryPts, detailPts);
          // Crisp cell sub-grid lines
          const cols = tier === 3 ? 4 : 3;
          for (let c = 1; c < cols; c++) {
            const lx = wx - wingSpanX / 2 + (wingSpanX * c) / cols;
            pushSeg(detailPts, lx, sz * (wingOffsetZ - wingDepthZ / 2), lx, sz * (wingOffsetZ + wingDepthZ / 2), wingY + 0.16);
          }
          pushSeg(detailPts, wx - wingSpanX / 2, sz * wingOffsetZ, wx + wingSpanX / 2, sz * wingOffsetZ, wingY + 0.16);
        }
      }
      break;
    }

    case 'BPO_DeepSpaceObservatory': {
      // Grand 2x2 circular geodesic observatory ring anchored to -X XLarge neck with open void at corners!
      roofHeight = 7.4;
      addWestNeck(4.5, 6.2, 3.2);
      addPolyDrum(extrudeGroup, minH * 0.72, minH * 0.66, 16, 0, 2.4, 0, fillBase, primaryPts, detailPts, {
        cx: 1.0,
        ribCount: 8,
      });
      addPolyDrum(extrudeGroup, minH * 0.64, minH * 0.56, 16, 2.4, 5.4, 0, fillUpper, primaryPts, detailPts, {
        cx: 1.0,
        ribCount: 8,
      });
      addPolyDrum(extrudeGroup, minH * 0.56, minH * 0.22, 16, 5.4, roofHeight, 0, fillBase, primaryPts, detailPts, {
        cx: 1.0,
        ribCount: 8,
      });
      // Prominent telescope slit & protruding lens barrel (+X)
      addRectBlock(extrudeGroup, 6.8, 0, 3.2, 1.3, 4.4, 6.2, fillUpper, primaryPts, detailPts);
      break;
    }

    case 'BPO_ShipyardCore':
    case 'BPO_ShipyardCore_02':
    case 'BPO_ShipyardSide': {
      // Open skeletal orbital drydock gantry frames (true real bounds: ShipyardSide = 9x16m offset -X, Core2 = 24x32m!)
      const isBig = def.id === 'BPO_ShipyardCore_02';
      const isSide = def.id === 'BPO_ShipyardSide';
      roofHeight = isBig ? 6.2 : 4.8;
      const spineX = isSide ? -hw + 2.8 : -hw + 2.6;
      const spineHalfX = isSide ? 2.4 : 2.2;
      // Structural spine along -X connector side
      addChamferPrism(extrudeGroup, spineHalfX, hd - 0.6, 0, roofHeight, 0.5, fillBase, primaryPts, detailPts, {
        cx: spineX,
      });
      // Slender cantilevered overhead gantry arms reaching out over open drydock build space (+X)
      const armReach = isSide ? 4.8 : isBig ? 17.5 : 10.2;
      const armCx = spineX + spineHalfX + armReach / 2;
      const armHalfZ = isBig ? 1.4 : 1.0;
      const zOffsets = isBig ? [-hd + 2.4, 0, hd - 2.4] : [-hd + 2.0, hd - 2.0];
      for (const oz of zOffsets) {
        addRectBlock(extrudeGroup, armCx, oz, armReach / 2, armHalfZ, roofHeight - 1.15, roofHeight, fillUpper, primaryPts, detailPts);
        // Vertical end-stanchion tick
        addRectBlock(extrudeGroup, spineX + spineHalfX + armReach - 0.6, oz, 0.6, armHalfZ * 0.85, 0, roofHeight - 1.15, fillBase, primaryPts, detailPts);
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
        isSelected ? 1.5 : 1.15,
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
