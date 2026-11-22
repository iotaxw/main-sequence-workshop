import * as THREE from 'three';
import { getBuildableDef } from './../core/catalog';
import {
  findBuildingAtCell,
  getBuildingCenterM,
  getBuildingSizeCells,
  getBuildingWorldPorts,
  rotationToDelta,
} from './../core/geometry';
import type { BlueprintDocument, BuildableDef, PlacedBuilding } from './../core/types';
import { createCrispLineSegments } from './crisp-lines';

/**
 * Restrained dark-CAD architectural line-art geometry builders.
 * - Vertical top-down view (pitch ~89 deg): extrudeGroup.scale.y -> ~0.01 (pure flat 2D blueprint plan).
 * - Tilted 3D perspectives (work 64 deg / iso 42 deg / low 22 deg): extrudeGroup.scale.y -> 1.0
 *   (sculpted hidden-line dark architectural silhouettes with crisp hairline contours).
 */

export const LINE_ART_PALETTE = {
  baseFill: 0x0c1119,
  baseFillSelected: 0x121c29,
  bodyFill: 0x0d131d,
  bodyFillUpper: 0x101723,
  bodyFillSelected: 0x142030,
  linePrimary: 0x768ca6,
  lineSecondary: 0x3e5168,
  lineDetail: 0x526882,
  lineSelected: 0xb2cde6,
  beltTrackFill: 0x0d141e,
  beltRailMk1: 0x4e6075,
  beltRailMk2: 0x6b88a4,
  beltRailMk3: 0x8ba3be,
  beltArrow: 0x849db8,
  portActiveLine: 0x50a87b,   // Restrained sage-emerald hairline slot
  portDisabledLine: 0x873d42, // Quiet muted crimson hairline slot
  researchTint: 0x629498,
  powerTint: 0xa28f58,
};

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
  widthPx = 1.15,
  lodTier: 'primary' | 'detail' = 'primary'
): THREE.Object3D {
  return createCrispLineSegments(pts, { color, opacity, widthPx, lodTier });
}

function createOcclusionMat(color: number, opacity: number, isGhost: boolean): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: isGhost || opacity < 0.99,
    opacity: isGhost ? opacity * 0.08 : opacity * 0.96,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 3,
    depthWrite: !isGhost && opacity >= 0.95,
  });
}

/**
 * Adds a dark hidden-line matte chamfered architectural prism + crisp wireframe contours.
 */
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

  // Matte occlusion solid
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

  // Crisp top & bottom contours + architectural vertical corner ribs
  pushLoop(primaryPts, loop, y1 + 0.004);
  if (!opts.omitBottom) {
    pushLoop(detailPts, loop, y0 + 0.002);
  }
  const ribTarget = opts.verticalToPrimary ? primaryPts : detailPts;
  for (const [x, z] of loop) {
    pushSeg(ribTarget, x, z, x, z, y0, y1);
  }
}

/**
 * Adds a dark hidden-line matte polygonal drum/frustum + clean horizontal rings & sparse architectural ribs.
 */
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
  // Align CylinderGeometry angle with cos(a), sin(a) convention
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

/**
 * Adds a clean rectangular architectural block (pylon, server blade, gantry beam).
 */
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
 * Flush elongated rectangular port marker hugging the building perimeter edge!
 * Active = clean sage-emerald hollow slot + thin center bar; Disabled = muted crimson slot + diagonal seal slash.
 */
function buildFlushPortMarker(
  wx: number,
  y: number,
  wz: number,
  side: 'N' | 'E' | 'S' | 'W',
  enabled: boolean,
  opacity: number
): THREE.Object3D {
  const pts: number[] = [];
  // Oriented flush along the wall edge
  const along = 0.27; // half-length along wall (0.54m total)
  const thick = 0.068; // half-depth perpendicular to wall (0.136m total)
  // Slight inward tuck so the slim bar sits flush against the building's inset edge
  let offX = 0;
  let offZ = 0;
  let hx = along;
  let hz = thick;

  if (side === 'N') {
    offZ = 0.08;
    hx = along;
    hz = thick;
  } else if (side === 'S') {
    offZ = -0.08;
    hx = along;
    hz = thick;
  } else if (side === 'E') {
    offX = -0.08;
    hx = thick;
    hz = along;
  } else {
    offX = 0.08;
    hx = thick;
    hz = along;
  }

  // Outer elongated slim rectangle
  pushRect(pts, hx, hz, 0, 0);

  if (enabled) {
    // Crisp thin inner parallel line (open architectural slot)
    if (side === 'N' || side === 'S') {
      pushSeg(pts, -hx * 0.62, 0, hx * 0.62, 0, 0, 0);
    } else {
      pushSeg(pts, 0, -hz * 0.62, 0, hz * 0.62, 0, 0);
    }
  } else {
    // Subtle diagonal seal slashes (closed/disabled slot)
    pushSeg(pts, -hx * 0.82, -hz * 0.82, hx * 0.82, hz * 0.82, 0, 0);
    pushSeg(pts, hx * 0.82, -hz * 0.82, -hx * 0.82, hz * 0.82, 0, 0);
  }

  const segs = buildLineSegments(
    pts,
    enabled ? LINE_ART_PALETTE.portActiveLine : LINE_ART_PALETTE.portDisabledLine,
    opacity * (enabled ? 0.94 : 0.72),
    1.1,
    'detail'
  );
  segs.position.set(wx + offX, y, wz + offZ);
  return segs;
}

/**
 * Minimalist continuous conveyor belt line-art:
 * Two clean parallel rails (zero tile divider seams) + seamless mitered L-turns + tier chevrons.
 */
export function buildBeltLineArt(
  doc: BlueprintDocument,
  b: PlacedBuilding,
  def: BuildableDef,
  baseY: number,
  opacity: number,
  isSelected: boolean
): THREE.Group {
  const group = new THREE.Group();
  const cx = b.x + 0.5;
  const cz = b.y + 0.5;
  const y = baseY + 0.04;

  const [outDx, outDy] = rotationToDelta(b.rotation);
  let inDir: [number, number] | null = null;
  const dirs: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dy] of dirs) {
    if (dx === outDx && dy === outDy) continue;
    const nb = findBuildingAtCell(doc, b.x + dx, b.y + dy, b.floor);
    if (!nb) continue;
    const nbDef = getBuildableDef(nb.type);
    if (!nbDef || !['belt', 'splitter', 'balancer', 'underground'].includes(nbDef.kind)) continue;
    const [nbOutDx, nbOutDy] = rotationToDelta(nb.rotation);
    if (nbOutDx === -dx && nbOutDy === -dy) {
      inDir = [-dx, -dy];
      break;
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
      : new THREE.PlaneGeometry(0.76, 0.76);
  bedGeo.rotateX(-Math.PI / 2);
  const bedMat = new THREE.MeshBasicMaterial({
    color: isSelected ? LINE_ART_PALETTE.baseFillSelected : LINE_ART_PALETTE.beltTrackFill,
    transparent: true,
    opacity: opacity * 0.85,
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
    pushSeg(railPts, -r, 0.5, -r, -r * 0.45, 0);
    pushSeg(railPts, -r, -r * 0.45, -r * 0.45, -r, 0);
    pushSeg(railPts, -r * 0.45, -r, 0.5, -r, 0);
    pushSeg(railPts, r, 0.5, r, r, 0);
    pushSeg(railPts, r, r, 0.5, r, 0);
  } else {
    pushSeg(railPts, -r, -0.5, -r, r * 0.45, 0);
    pushSeg(railPts, -r, r * 0.45, -r * 0.45, r, 0);
    pushSeg(railPts, -r * 0.45, r, 0.5, r, 0);
    pushSeg(railPts, r, -0.5, r, -r, 0);
    pushSeg(railPts, r, -r, 0.5, -r, 0);
  }

  const railColor = isSelected
    ? LINE_ART_PALETTE.lineSelected
    : def.tier === 3
      ? LINE_ART_PALETTE.beltRailMk3
      : def.tier === 2
        ? LINE_ART_PALETTE.beltRailMk2
        : LINE_ART_PALETTE.beltRailMk1;

  const railLines = buildLineSegments(railPts, railColor, opacity * (isSelected ? 1.0 : 0.84), 1.05, 'primary');
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
    isSelected ? 0xdbeafe : LINE_ART_PALETTE.beltArrow,
    opacity * (isSelected ? 1.0 : 0.76),
    0.9,
    'detail'
  );
  chevLines.position.set(cx, y + 0.015, cz);
  chevLines.rotation.y = -b.rotation * (Math.PI / 2);
  group.add(chevLines);

  return group;
}

/**
 * Build pitch-responsive sculpted architectural line-art for any non-belt building/machine.
 * - Baseplate & flush rectangular wall ports remain anchored to baseY.
 * - Sculpted 3D architectural mass lives inside `extrudeGroup` (local Y in [0, roofHeight])
 *   so SceneController smoothly flattens it to 2D in pure vertical top-down view and rises it in 3D angles!
 */
export function buildMachineLineArt(
  b: PlacedBuilding,
  def: BuildableDef,
  baseY: number,
  opacity: number,
  isSelected: boolean,
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

  // 1. Flat floor baseplate (anchored at floorY, never scaled)
  const plateGeo = new THREE.PlaneGeometry(w - inset * 2, d - inset * 2);
  plateGeo.rotateX(-Math.PI / 2);
  const plateMat = new THREE.MeshBasicMaterial({
    color: isGhost ? ghostTint : isSelected ? LINE_ART_PALETTE.baseFillSelected : LINE_ART_PALETTE.baseFill,
    transparent: true,
    opacity: isGhost ? opacity * 0.08 : opacity * 0.94,
    depthWrite: false,
  });
  const plate = new THREE.Mesh(plateGeo, plateMat);
  plate.position.set(cx, floorY, cz);
  root.add(plate);

  // 2. Sculpted 3D Architectural Volume (scales smoothly on Y with camera pitch!)
  const extrudeGroup = new THREE.Group();
  extrudeGroup.position.set(cx, floorY + 0.005, cz);
  extrudeGroup.rotation.y = -b.rotation * (Math.PI / 2);

  const fillBase = createOcclusionMat(
    isGhost ? ghostTint : isSelected ? LINE_ART_PALETTE.bodyFillSelected : LINE_ART_PALETTE.bodyFill,
    opacity,
    isGhost
  );
  const fillUpper = createOcclusionMat(
    isGhost ? ghostTint : isSelected ? LINE_ART_PALETTE.bodyFillSelected : LINE_ART_PALETTE.bodyFillUpper,
    opacity,
    isGhost
  );

  const primaryPts: number[] = [];
  const detailPts: number[] = [];
  let roofHeight = 1.2;

  const primaryColor = isGhost
    ? ghostTint
    : isSelected
      ? LINE_ART_PALETTE.lineSelected
      : def.kind === 'research'
        ? LINE_ART_PALETTE.researchTint
        : def.kind === 'reactor'
          ? LINE_ART_PALETTE.powerTint
          : LINE_ART_PALETTE.linePrimary;

  switch (def.id) {
    case 'DAT_Refinery': {
      // Tiered octagonal thermal plinth + tapered cylindrical furnace core + top flue collar + 4 diagonal buttresses
      roofHeight = 1.48;
      addChamferPrism(extrudeGroup, hw, hd, 0, 0.54, 0.34, fillBase, primaryPts, detailPts);
      addPolyDrum(extrudeGroup, minH * 0.62, minH * 0.54, 16, 0.54, 1.26, 0, fillUpper, primaryPts, detailPts, {
        ribCount: 8,
      });
      addPolyDrum(extrudeGroup, minH * 0.32, minH * 0.28, 8, 1.26, roofHeight, Math.PI / 8, fillBase, primaryPts, detailPts, {
        ribCount: 4,
      });
      // 4 diagonal structural fins from plinth deck to drum shoulder
      const r0 = minH * 0.56;
      const r1 = minH * 0.92;
      for (let i = 0; i < 4; i++) {
        const a = Math.PI / 4 + (i * Math.PI) / 2;
        pushSeg(detailPts, Math.cos(a) * r1, Math.sin(a) * r1, Math.cos(a) * r0, Math.sin(a) * r0, 0.54, 1.2);
      }
      break;
    }

    case 'DAT_Assembler': {
      // Chamfered industrial hall + stepped inner gantry deck + twin side bridge walls + elevated central diamond core
      roofHeight = 1.85;
      addChamferPrism(extrudeGroup, hw, hd, 0, 0.72, 0.38, fillBase, primaryPts, detailPts);
      addChamferPrism(extrudeGroup, hw * 0.72, hd * 0.72, 0.72, 1.38, 0.18, fillUpper, primaryPts, detailPts);
      // Central elevated diamond precision turret
      addPolyDrum(extrudeGroup, minH * 0.36, minH * 0.34, 4, 1.38, roofHeight, 0, fillBase, primaryPts, detailPts, {
        ribCount: 4,
      });
      // Orthogonal gantry rail ticks across upper deck
      pushSeg(detailPts, -hw * 0.72, 0, -minH * 0.36, 0, 1.39, 1.39);
      pushSeg(detailPts, minH * 0.36, 0, hw * 0.72, 0, 1.39, 1.39);
      pushSeg(detailPts, 0, -hd * 0.72, 0, -minH * 0.36, 1.39, 1.39);
      pushSeg(detailPts, 0, minH * 0.36, 0, hd * 0.72, 1.39, 1.39);
      break;
    }

    case 'DAT_AdvancedAssembler': {
      // Grand 9x9 double-terraced assembly complex + 4 quadrant bay wings + elevated diamond nexus spire
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
      // 9x9 stepped octagonal pedestal + 3 telescoping concentric centrifuge drums
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
      // 7x7 plinth + 5 tall parallel vertical blade-server fin slabs + elevated transverse optical bus bar
      roofHeight = 2.32;
      addChamferPrism(extrudeGroup, hw, hd, 0, 0.48, 0.38, fillBase, primaryPts, detailPts);
      const bladeCount = 5;
      const spanX = hw * 1.48;
      for (let i = 0; i < bladeCount; i++) {
        const x = -spanX / 2 + (spanX * i) / (bladeCount - 1);
        addRectBlock(extrudeGroup, x, 0, 0.2, hd * 0.72, 0.48, 2.08, fillUpper, primaryPts, detailPts);
      }
      // Elevated central optical bus bridge spanning all 5 blades
      addRectBlock(extrudeGroup, 0, 0, hw * 0.86, 0.26, 2.08, roofHeight, fillBase, primaryPts, detailPts);
      break;
    }

    case 'DAT_GrowthChamber': {
      // 7x7 chamfered hydroponic base + hexagonal geodesic conservatory pavilion + tapered cupola
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
      // 9x9 diamond altar + 4 corner architectural obelisk pylons + central floating prism core
      roofHeight = 2.85;
      addChamferPrism(extrudeGroup, hw, hd, 0, 0.82, 0.9, fillBase, primaryPts, detailPts);
      addPolyDrum(extrudeGroup, minH * 0.68, minH * 0.6, 4, 0.82, 1.65, 0, fillUpper, primaryPts, detailPts, {
        ribCount: 4,
      });
      // 4 tall corner obelisks
      const pOff = minH * 0.64;
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          addRectBlock(extrudeGroup, sx * pOff, sz * pOff, 0.42, 0.42, 0.82, 2.38, fillBase, primaryPts, detailPts);
        }
      }
      // Central synthesized crystal column
      addPolyDrum(extrudeGroup, minH * 0.24, minH * 0.14, 8, 1.65, roofHeight, Math.PI / 8, fillUpper, primaryPts, detailPts, {
        ribCount: 4,
      });
      break;
    }

    case 'DAT_ReactorMachine': {
      // 6x6 octagonal heavy containment base + central plasma core column + 3 radial cooling fins
      roofHeight = 2.55;
      addChamferPrism(extrudeGroup, hw, hd, 0, 0.88, 0.62, fillBase, primaryPts, detailPts);
      addPolyDrum(extrudeGroup, minH * 0.44, minH * 0.36, 12, 0.88, roofHeight, 0, fillUpper, primaryPts, detailPts, {
        ribCount: 6,
      });
      // 3 radial cooling fin ribs
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
      // Clean ribbed industrial storage vault with stepped beveled cap
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
      // Clean structural top bay dividers
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
      // Sleek low-profile arched splitter housing with crisp top flow cross + chevron
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
      // Sleek 1x2 arched dual-lane transfer bridge with X-routing schematic on roof
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
      // Iconic low hooded tunnel portal (raised hood on tunnel end, low ramp on belt end)
      roofHeight = 0.44;
      const isOut = b.undergroundMode === 'out';
      const hoodCenter = isOut ? -hw * 0.22 : hw * 0.22;
      addRectBlock(extrudeGroup, hoodCenter, 0, hw * 0.68, hd * 0.88, 0, roofHeight, fillBase, primaryPts, detailPts);
      pushChevron(primaryPts, isOut ? 0.18 : -0.18, 0, 0.24, roofHeight + 0.008);
      break;
    }

    case 'DAT_Teleporter': {
      // 4x4 stepped triple-concentric portal rings
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
        // Distinct sculpted laboratory forms scaled cleanly by size (3x3 / 5x5 / 9x9)
        roofHeight = lw >= 9 ? 2.65 : lw >= 5 ? 1.92 : 1.52;
        addChamferPrism(extrudeGroup, hw, hd, 0, roofHeight * 0.42, Math.min(0.45, minH * 0.24), fillBase, primaryPts, detailPts);

        if (def.id === 'DAT_QuantumSciLab') {
          // Tiered circular base + central quantum core + crossed high rings
          addPolyDrum(extrudeGroup, minH * 0.72, minH * 0.64, 24, roofHeight * 0.42, roofHeight * 0.76, 0, fillUpper, primaryPts, detailPts, {
            ribCount: 8,
          });
          addPolyDrum(extrudeGroup, minH * 0.32, minH * 0.24, 12, roofHeight * 0.76, roofHeight, 0, fillBase, primaryPts, detailPts, {
            ribCount: 6,
          });
        } else if (def.id === 'DAT_AstroSciLab') {
          // Faceted observatory dome
          addPolyDrum(extrudeGroup, minH * 0.76, minH * 0.62, 12, roofHeight * 0.42, roofHeight * 0.78, 0, fillUpper, primaryPts, detailPts, {
            ribCount: 6,
          });
          addPolyDrum(extrudeGroup, minH * 0.62, minH * 0.2, 12, roofHeight * 0.78, roofHeight, 0, fillBase, primaryPts, detailPts, {
            ribCount: 6,
          });
        } else if (def.id === 'DAT_XenoSciLab') {
          // Hexagonal bio-prism chamber
          addPolyDrum(extrudeGroup, minH * 0.72, minH * 0.62, 6, roofHeight * 0.42, roofHeight * 0.84, Math.PI / 6, fillUpper, primaryPts, detailPts, {
            ribCount: 6,
          });
          addPolyDrum(extrudeGroup, minH * 0.36, minH * 0.22, 3, roofHeight * 0.84, roofHeight, 0, fillBase, primaryPts, detailPts, {
            ribCount: 3,
          });
        } else if (def.id === 'DAT_ElectroSciLab') {
          // Diamond electromagnetic coil cage
          addPolyDrum(extrudeGroup, minH * 0.74, minH * 0.64, 4, roofHeight * 0.42, roofHeight * 0.84, 0, fillUpper, primaryPts, detailPts, {
            ribCount: 4,
          });
          addPolyDrum(extrudeGroup, minH * 0.26, minH * 0.26, 8, roofHeight * 0.84, roofHeight, 0, fillBase, primaryPts, detailPts, {
            ribCount: 4,
          });
        } else if (def.id === 'DAT_CompSciLab') {
          // Stepped cubic computation core
          addChamferPrism(extrudeGroup, hw * 0.62, hd * 0.62, roofHeight * 0.42, roofHeight, 0.14, fillUpper, primaryPts, detailPts);
        } else {
          // MatSciLab / RelicAnalyzer: clean concentric optical drum
          addPolyDrum(extrudeGroup, minH * 0.68, minH * 0.58, 16, roofHeight * 0.42, roofHeight, 0, fillUpper, primaryPts, detailPts, {
            ribCount: 8,
          });
        }
        // Subtle roof crosshairs
        pushSeg(detailPts, -minH * 0.68, 0, minH * 0.68, 0, roofHeight + 0.005, roofHeight + 0.005);
        pushSeg(detailPts, 0, -minH * 0.68, 0, minH * 0.68, roofHeight + 0.005, roofHeight + 0.005);
      } else {
        // Decorations (SignWall, Chair, CoffeeTable, Plant)
        roofHeight = def.id === 'DAT_SignWall' ? 1.1 : 0.62;
        addChamferPrism(extrudeGroup, hw * 0.82, hd * 0.82, 0, roofHeight, 0.08, fillBase, primaryPts, detailPts);
      }
      break;
    }
  }

  if (primaryPts.length > 0) {
    extrudeGroup.add(
      buildLineSegments(
        primaryPts,
        primaryColor,
        opacity * (isGhost ? 0.96 : isSelected ? 1.0 : 0.9),
        isSelected ? 1.45 : 1.18,
        'primary'
      )
    );
  }
  if (detailPts.length > 0) {
    extrudeGroup.add(
      buildLineSegments(
        detailPts,
        isGhost ? ghostTint : isSelected ? LINE_ART_PALETTE.linePrimary : LINE_ART_PALETTE.lineDetail,
        opacity * (isGhost ? 0.62 : isSelected ? 0.86 : 0.6),
        0.85,
        'detail'
      )
    );
  }

  root.add(extrudeGroup);

  // 3. Flush elongated rectangular wall ports anchored to the floor perimeter!
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
          opacity * (isGhost ? 0.78 : 1)
        )
      );
    }
  }

  return { root, extrudeGroup, roofHeight };
}
