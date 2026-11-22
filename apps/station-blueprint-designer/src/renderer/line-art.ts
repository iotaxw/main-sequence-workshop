import * as THREE from 'three';
import { getBuildableDef } from './../core/catalog';
import {
  findBuildingAtCell,
  getBuildingCenterM,
  getBuildingSizeCells,
  getBuildingWorldPorts,
  getModuleCenterM,
  getModuleSizeUnits,
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

  const bedGeo =
    localTurn === 'straight'
      ? new THREE.PlaneGeometry(0.98, 0.54)
      : new THREE.PlaneGeometry(0.78, 0.78);
  bedGeo.rotateX(-Math.PI / 2);
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
  const r = 0.27;

  if (localTurn === 'straight') {
    pushSeg(railPts, -0.5, -r, 0.5, -r, 0);
    pushSeg(railPts, -0.5, r, 0.5, r, 0);
  } else if (localTurn === 'right') {
    // Clockwise turn: entering +Z (South) -> exiting +X (East); pivot at (+0.5, +0.5)
    pushArc(railPts, 0.5, 0.5, 0.5 + r, Math.PI, Math.PI * 1.5, 6, 0);
    pushArc(railPts, 0.5, 0.5, 0.5 - r, Math.PI, Math.PI * 1.5, 4, 0);
  } else {
    // Counter-clockwise turn: entering -Z (North) -> exiting +X (East); pivot at (+0.5, -0.5)
    pushArc(railPts, 0.5, -0.5, 0.5 + r, Math.PI, Math.PI * 0.5, 6, 0);
    pushArc(railPts, 0.5, -0.5, 0.5 - r, Math.PI, Math.PI * 0.5, 4, 0);
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
 * Unified pitch-responsive architectural 3D/2D line-art for ALL non-factory-floor station modules
 * (Armour A/B, Plasma Turret, Solar Panels I/II/III, Mining Bays I/II, Command, Dock, Scanner,
 *  Deep Space Observatory, Shipyard Core I/II & Side).
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
  const [wu, du] = getModuleSizeUnits(def, mod.rotation);
  const floorY = baseY;
  const isGhost = ghostTint !== undefined;

  // Local unrotated dimensions (meters)
  const lw = def.sizeUnits[0] * STATION_UNIT_M;
  const ld = def.sizeUnits[1] * STATION_UNIT_M;
  const hw = lw / 2 - 0.35;
  const hd = ld / 2 - 0.35;
  const minH = Math.min(hw, hd);

  // Subtle flat anchor deck (keeps footprints clear in 2D top-down)
  const wM = wu * STATION_UNIT_M;
  const dM = du * STATION_UNIT_M;
  const deckGeo = new THREE.PlaneGeometry(wM - 0.25, dM - 0.25);
  deckGeo.rotateX(-Math.PI / 2);
  const deckMat = new THREE.MeshBasicMaterial({
    color: isGhost ? ghostTint : isSelected ? palette.baseFillSelected : palette.slabFill,
    transparent: isGhost || opacity < 0.99,
    opacity: isGhost ? opacity * 0.06 : opacity * 0.86,
    depthWrite: false,
  });
  const deck = new THREE.Mesh(deckGeo, deckMat);
  deck.position.set(cx, floorY - 0.02, cz);
  root.add(deck);

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

  switch (def.id) {
    case 'BPO_StationArmour_01':
    case 'BPO_StationArmour_01B': {
      // Sculpted sloped wedge armour hull (01B is exact mirrored orientation!)
      const mirrored = def.id === 'BPO_StationArmour_01B';
      roofHeight = 3.6;
      addSlopedArmourPlate(extrudeGroup, hw * 0.94, hd * 0.94, roofHeight, 1.15, mirrored, fillBase, primaryPts, detailPts);
      break;
    }

    case 'BPO_StationTurretBlock_01': {
      // Octagonal armored gun pedestal + rotating cylindrical turret + twin parallel plasma barrels (+X)
      roofHeight = 4.4;
      addChamferPrism(extrudeGroup, hw * 0.86, hd * 0.86, 0, 1.65, 2.2, fillBase, primaryPts, detailPts);
      addPolyDrum(extrudeGroup, minH * 0.56, minH * 0.48, 8, 1.65, 3.35, Math.PI / 8, fillUpper, primaryPts, detailPts, {
        ribCount: 8,
      });
      addChamferPrism(extrudeGroup, 2.6, 2.2, 3.35, roofHeight, 0.6, fillBase, primaryPts, detailPts, { cx: -0.4 });
      // Twin long plasma cannon barrels extending toward +X
      addRectBlock(extrudeGroup, 3.8, -1.1, 3.4, 0.42, 2.65, 3.45, fillUpper, primaryPts, detailPts);
      addRectBlock(extrudeGroup, 3.8, 1.1, 3.4, 0.42, 2.65, 3.45, fillUpper, primaryPts, detailPts);
      break;
    }

    case 'BPO_SolarPanelBlock':
    case 'BPO_SolarPanelBlock_02':
    case 'BPO_SolarPanelBlock_03': {
      // Structural central truss spine + sleek cantilevered solar wing arrays with photovoltaic grid lines
      const tier = def.id.endsWith('03') ? 3 : def.id.endsWith('02') ? 2 : 1;
      roofHeight = tier >= 2 ? 4.2 : 2.6;
      const wingY = roofHeight * 0.72;
      // Central mounting spine
      addChamferPrism(extrudeGroup, hw * 0.24, hd * 0.9, 0, roofHeight, 0.5, fillBase, primaryPts, detailPts);
      // Left & right thin photovoltaic wing slabs
      const wingX = hw * 0.6;
      const wingHx = hw * 0.34;
      const wingHz = hd * 0.88;
      addRectBlock(extrudeGroup, -wingX, 0, wingHx, wingHz, wingY - 0.16, wingY + 0.16, fillUpper, primaryPts, detailPts);
      addRectBlock(extrudeGroup, wingX, 0, wingHx, wingHz, wingY - 0.16, wingY + 0.16, fillUpper, primaryPts, detailPts);
      // Clean photovoltaic cell ribs
      const rows = tier === 3 ? 6 : 4;
      for (let i = 1; i < rows; i++) {
        const z = -wingHz + (2 * wingHz * i) / rows;
        pushSeg(detailPts, -wingX - wingHx, z, -wingX + wingHx, z, wingY + 0.18, wingY + 0.18);
        pushSeg(detailPts, wingX - wingHx, z, wingX + wingHx, z, wingY + 0.18, wingY + 0.18);
      }
      break;
    }

    case 'BPO_MiningDroneBayBlock':
    case 'BPO_MiningDroneBayBlock_2': {
      // Armored industrial hangar + twin (Mk.1) / quad (Mk.2) launch hatches & guide rails
      const mk2 = def.id.endsWith('_2');
      roofHeight = mk2 ? 4.4 : 3.4;
      addChamferPrism(extrudeGroup, hw * 0.92, hd * 0.92, 0, 1.8, 1.4, fillBase, primaryPts, detailPts);
      addChamferPrism(extrudeGroup, hw * 0.72, hd * 0.72, 1.8, roofHeight, 0.9, fillUpper, primaryPts, detailPts);
      // Launch bay recessed hatches on top deck
      if (mk2) {
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            pushRect(primaryPts, hw * 0.24, hd * 0.24, roofHeight + 0.02, 0.2);
            pushSeg(detailPts, sx * hw * 0.34, sz * hd * 0.1, sx * hw * 0.34, sz * hd * 0.56, roofHeight + 0.02);
          }
        }
        pushSeg(primaryPts, -hw * 0.68, 0, hw * 0.68, 0, roofHeight + 0.02);
        pushSeg(primaryPts, 0, -hd * 0.68, 0, hd * 0.68, roofHeight + 0.02);
      } else {
        pushSeg(primaryPts, 0, -hd * 0.66, 0, hd * 0.66, roofHeight + 0.02);
        pushRect(detailPts, hw * 0.54, hd * 0.54, roofHeight + 0.02, 0.3);
      }
      break;
    }

    case 'BPO_CommandModule': {
      // Tiered hexagonal command superstructure + elevated bridge crown + dual comms masts
      roofHeight = 5.4;
      addChamferPrism(extrudeGroup, hw * 0.88, hd * 0.88, 0, 1.8, 2.2, fillBase, primaryPts, detailPts);
      addPolyDrum(extrudeGroup, minH * 0.68, minH * 0.56, 6, 1.8, 3.7, Math.PI / 6, fillUpper, primaryPts, detailPts, {
        ribCount: 6,
      });
      addPolyDrum(extrudeGroup, minH * 0.34, minH * 0.26, 6, 3.7, 4.6, Math.PI / 6, fillBase, primaryPts, detailPts, {
        ribCount: 6,
      });
      // Dual delicate comms spires
      pushSeg(primaryPts, -1.2, 0, -1.2, 0, 4.6, roofHeight);
      pushSeg(primaryPts, 1.2, 0, 1.2, 0, 4.6, roofHeight - 0.5);
      break;
    }

    case 'BPO_Dock': {
      // Precision docking collar + twin alignment clamp arms
      roofHeight = 3.2;
      addChamferPrism(extrudeGroup, hw * 0.88, hd * 0.88, 0, 1.4, 1.6, fillBase, primaryPts, detailPts);
      addPolyDrum(extrudeGroup, minH * 0.52, minH * 0.46, 16, 1.4, roofHeight, 0, fillUpper, primaryPts, detailPts, {
        ribCount: 8,
      });
      // Docking clamp rails extending outward
      addRectBlock(extrudeGroup, hw * 0.55, -hd * 0.52, hw * 0.32, 0.75, 0, 2.2, fillBase, primaryPts, detailPts);
      addRectBlock(extrudeGroup, hw * 0.55, hd * 0.52, hw * 0.32, 0.75, 0, 2.2, fillBase, primaryPts, detailPts);
      break;
    }

    case 'BPO_ScannerModule': {
      // Octagonal pedestal + parabolic sensor dish + central emitter mast
      roofHeight = 5.2;
      addChamferPrism(extrudeGroup, hw * 0.84, hd * 0.84, 0, 1.5, 2.0, fillBase, primaryPts, detailPts);
      addPolyDrum(extrudeGroup, minH * 0.34, minH * 0.76, 16, 1.5, 3.6, 0, fillUpper, primaryPts, detailPts, {
        ribCount: 8,
      });
      pushSeg(primaryPts, 0, 0, 0, 0, 3.6, roofHeight);
      pushPolygon(primaryPts, minH * 0.2, 8, roofHeight - 0.4, 0);
      break;
    }

    case 'BPO_DeepSpaceObservatory': {
      // Grand 2x2 geodesic observatory dome + stepped ring plinth + telescope slit
      roofHeight = 7.4;
      addChamferPrism(extrudeGroup, hw * 0.92, hd * 0.92, 0, 2.0, 4.2, fillBase, primaryPts, detailPts);
      addPolyDrum(extrudeGroup, minH * 0.78, minH * 0.7, 16, 2.0, 5.2, 0, fillUpper, primaryPts, detailPts, {
        ribCount: 8,
      });
      addPolyDrum(extrudeGroup, minH * 0.7, minH * 0.28, 16, 5.2, roofHeight, 0, fillBase, primaryPts, detailPts, {
        ribCount: 8,
      });
      // Telescope aperture slit
      pushSeg(primaryPts, -1.2, -minH * 0.68, -1.2, minH * 0.68, 5.3, 5.3);
      pushSeg(primaryPts, 1.2, -minH * 0.68, 1.2, minH * 0.68, 5.3, 5.3);
      break;
    }

    case 'BPO_ShipyardCore':
    case 'BPO_ShipyardCore_02':
    case 'BPO_ShipyardSide': {
      // Heavy orbital drydock gantry bay with parallel structural arms & overhead truss arches
      const isBig = def.id === 'BPO_ShipyardCore_02';
      roofHeight = isBig ? 6.2 : 4.6;
      const armT = isBig ? 2.4 : 1.6;
      addRectBlock(extrudeGroup, 0, -hd + armT, hw * 0.92, armT, 0, roofHeight, fillBase, primaryPts, detailPts);
      addRectBlock(extrudeGroup, 0, hd - armT, hw * 0.92, armT, 0, roofHeight, fillBase, primaryPts, detailPts);
      // Transverse overhead gantry bridges
      const bridges = isBig ? [-hw * 0.55, 0, hw * 0.55] : [-hw * 0.42, hw * 0.42];
      for (const bx of bridges) {
        addRectBlock(extrudeGroup, bx, 0, armT * 0.55, hd - armT * 2, roofHeight - 1.1, roofHeight, fillUpper, primaryPts, detailPts);
      }
      break;
    }

    default: {
      roofHeight = 3.2;
      addChamferPrism(extrudeGroup, hw * 0.88, hd * 0.88, 0, roofHeight, 1.4, fillBase, primaryPts, detailPts);
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
