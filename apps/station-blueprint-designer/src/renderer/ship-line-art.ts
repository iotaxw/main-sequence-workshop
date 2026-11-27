import * as THREE from 'three';
import {
  getModuleCenterM,
  getModuleFloorShift,
  getModuleOriginOffsetM,
  getModuleUnitM,
} from '../core/geometry';
import type { PlacedModule, StationModuleDef } from '../core/types';
import { createCrispLineSegments } from './crisp-lines';
import type { MachineLineArtResult } from './line-art';
import { CAD_THEMES, type CadThemePalette } from './theme';

/**
 * SOP v2.0 True-to-Game 3D CAD Builder for all 45 Ship Modules (Build 26639889).
 * Drafted directly against 3-view (Top / Side / Iso) LOD0 hard-edge reference sheets extracted
 * from `MainSequence-Windows.pak` (including SCS transforms & DefaultMachine attachments).
 *
 * Local coordinate convention (UE5-native, displayed bow-LEFT at default 180° ship camera yaw):
 * - +X = Ship Bow (forward), -X = Ship Stern (aft)
 * - +Z = Starboard (+Y in 2D blueprint), -Z = Port (-Y in 2D blueprint)
 * - +Y = Up (height in meters)
 *
 * Overhanging visuals (e.g. 18.0m Relic Thruster / 13.2m Small Thruster / wide Medium Bridge)
 * retain full authentic silhouette while displaying a subtle dashed collision footprint box
 * matching `blockBoundsM`, clearly communicating their exact 1-block / grid collision boundary.
 */

function pushSeg(out: number[], x1: number, z1: number, x2: number, z2: number, y1 = 0, y2 = y1): void {
  out.push(x1, y1, z1, x2, y2, z2);
}

function pushLoop(out: number[], pts: Array<[number, number]>, y = 0): void {
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    pushSeg(out, a[0], a[1], b[0], b[1], y, y);
  }
}

function pushPolygon(
  out: number[],
  r: number,
  sides: number,
  y = 0,
  rotOffset = 0,
  cx = 0,
  cz = 0
): void {
  for (let i = 0; i < sides; i++) {
    const a0 = rotOffset + (i / sides) * Math.PI * 2;
    const a1 = rotOffset + ((i + 1) / sides) * Math.PI * 2;
    pushSeg(out, cx + Math.cos(a0) * r, cz + Math.sin(a0) * r, cx + Math.cos(a1) * r, cz + Math.sin(a1) * r, y, y);
  }
}

function pushArc(
  out: number[],
  cx: number,
  cz: number,
  r: number,
  a0: number,
  a1: number,
  segs: number,
  y = 0
): void {
  for (let i = 0; i < segs; i++) {
    const t0 = a0 + ((a1 - a0) * i) / segs;
    const t1 = a0 + ((a1 - a0) * (i + 1)) / segs;
    pushSeg(out, cx + Math.cos(t0) * r, cz + Math.sin(t0) * r, cx + Math.cos(t1) * r, cz + Math.sin(t1) * r, y, y);
  }
}

function getChamferLoop(hw: number, hd: number, chamfer: number, cx = 0, cz = 0): Array<[number, number]> {
  if (chamfer <= 0.001) {
    return [
      [cx - hw, cz - hd],
      [cx + hw, cz - hd],
      [cx + hw, cz + hd],
      [cx - hw, cz + hd],
    ];
  }
  const c = Math.min(chamfer, hw * 0.45, hd * 0.45);
  return [
    [cx - hw + c, cz - hd],
    [cx + hw - c, cz - hd],
    [cx + hw, cz - hd + c],
    [cx + hw, cz + hd - c],
    [cx + hw - c, cz + hd],
    [cx - hw + c, cz + hd],
    [cx - hw, cz + hd - c],
    [cx - hw, cz - hd + c],
  ];
}

function makeDLoop(flatX: number, arcCenterX: number, radiusX: number, radiusZ: number, segs = 12): Array<[number, number]> {
  // Flat connector face on +X (bow), smooth semicircle curving back to -X (stern)
  const pts: Array<[number, number]> = [
    [flatX, -radiusZ],
    [flatX, radiusZ],
  ];
  for (let i = 0; i <= segs; i++) {
    const ang = Math.PI * 0.5 + (Math.PI * i) / segs; // +PI/2 -> +3PI/2 (curving through -X)
    pts.push([arcCenterX + Math.cos(ang) * radiusX, Math.sin(ang) * radiusZ]);
  }
  return pts;
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

function addExtrudedLoop(
  target: THREE.Group,
  loop: Array<[number, number]>,
  y0: number,
  y1: number,
  fillMat: THREE.Material,
  primaryPts: number[],
  detailPts: number[],
  opts: { verticalToPrimary?: boolean; skipVertStep?: number; holeRadius?: number; holeCx?: number; holeCz?: number } = {}
): void {
  const h = y1 - y0;
  if (h <= 0.01 || loop.length < 3) return;
  const shape = new THREE.Shape();
  shape.moveTo(loop[0][0], -loop[0][1]);
  for (let i = 1; i < loop.length; i++) shape.lineTo(loop[i][0], -loop[i][1]);
  shape.closePath();

  if (opts.holeRadius && opts.holeRadius > 0.05) {
    const hcx = opts.holeCx ?? 0;
    const hcz = opts.holeCz ?? 0;
    const hole = new THREE.Path();
    const hSegs = 16;
    for (let i = 0; i <= hSegs; i++) {
      const a = (i / hSegs) * Math.PI * 2;
      const hx = hcx + Math.cos(a) * opts.holeRadius;
      const hy = -(hcz + Math.sin(a) * opts.holeRadius);
      if (i === 0) hole.moveTo(hx, hy);
      else hole.lineTo(hx, hy);
    }
    shape.holes.push(hole);
  }

  const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 1 });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, y0, 0);
  target.add(new THREE.Mesh(geo, fillMat));

  pushLoop(primaryPts, loop, y1 + 0.01);
  pushLoop(detailPts, loop, y0 + 0.01);
  const vOut = opts.verticalToPrimary ? primaryPts : detailPts;
  const step = Math.max(1, opts.skipVertStep ?? 1);
  for (let i = 0; i < loop.length; i += step) {
    const [px, pz] = loop[i];
    pushSeg(vOut, px, pz, px, pz, y0, y1);
  }
}

function addBox(
  target: THREE.Group,
  cx: number,
  cz: number,
  hw: number,
  hd: number,
  y0: number,
  y1: number,
  fillMat: THREE.Material,
  primaryPts: number[],
  detailPts: number[],
  chamfer = 0,
  verticalToPrimary = false
): void {
  addExtrudedLoop(target, getChamferLoop(hw, hd, chamfer, cx, cz), y0, y1, fillMat, primaryPts, detailPts, {
    verticalToPrimary,
  });
}

function addDrum(
  target: THREE.Group,
  cx: number,
  cz: number,
  rBottom: number,
  rTop: number,
  sides: number,
  y0: number,
  y1: number,
  rotOffset: number,
  fillMat: THREE.Material,
  primaryPts: number[],
  detailPts: number[],
  ribCount = 4
): void {
  const h = y1 - y0;
  if (h <= 0.01) return;
  const geo = new THREE.CylinderGeometry(rTop, rBottom, h, sides, 1, false);
  geo.rotateY(rotOffset);
  geo.translate(cx, (y0 + y1) / 2, cz);
  target.add(new THREE.Mesh(geo, fillMat));
  pushPolygon(primaryPts, rTop, sides, y1 + 0.01, rotOffset, cx, cz);
  pushPolygon(detailPts, rBottom, sides, y0 + 0.01, rotOffset, cx, cz);
  for (let k = 0; k < ribCount; k++) {
    const a = rotOffset + (k / ribCount) * Math.PI * 2;
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

/** Add a tapered horizontal exhaust nozzle pointing toward -X (stern) */
function addAftNozzle(
  target: THREE.Group,
  xFront: number,
  xBack: number,
  cz: number,
  cy: number,
  rFront: number,
  rBack: number,
  fillMat: THREE.Material,
  primaryPts: number[],
  detailPts: number[],
  sides = 8
): void {
  const len = Math.abs(xFront - xBack);
  if (len <= 0.05) return;
  const geo = new THREE.CylinderGeometry(rFront, rBack, len, sides, 1, false);
  geo.rotateZ(-Math.PI / 2); // +Y -> +X (front), -Y -> -X (back)
  geo.translate((xFront + xBack) / 2, cy, cz);
  target.add(new THREE.Mesh(geo, fillMat));

  // Front & back ellipse/circle outlines in YZ plane + 4 horizontal contour lines
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2;
    const a1 = ((i + 1) / sides) * Math.PI * 2;
    pushSeg(
      primaryPts,
      xBack,
      cz + Math.cos(a0) * rBack,
      xBack,
      cz + Math.cos(a1) * rBack,
      cy + Math.sin(a0) * rBack,
      cy + Math.sin(a1) * rBack
    );
    pushSeg(
      detailPts,
      xFront,
      cz + Math.cos(a0) * rFront,
      xFront,
      cz + Math.cos(a1) * rFront,
      cy + Math.sin(a0) * rFront,
      cy + Math.sin(a1) * rFront
    );
  }
  for (const a of [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5]) {
    pushSeg(
      primaryPts,
      xFront,
      cz + Math.cos(a) * rFront,
      xBack,
      cz + Math.cos(a) * rBack,
      cy + Math.sin(a) * rFront,
      cy + Math.sin(a) * rBack
    );
  }
}

/** True sloped wedge prism sloping along X from yBack (at x0) to yFront (at x1) */
function addSlopedWedge(
  target: THREE.Group,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  yBase: number,
  yBack: number,
  yFront: number,
  fillMat: THREE.Material,
  primaryPts: number[],
  detailPts: number[]
): void {
  const w = z1 - z0;
  const shape = new THREE.Shape();
  shape.moveTo(x0, yBase);
  shape.lineTo(x1, yBase);
  shape.lineTo(x1, yFront);
  shape.lineTo(x0, yBack);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false, curveSegments: 1 });
  // ExtrudeGeometry extrudes along +Z from 0..w, shift to z0..z1
  geo.translate(0, 0, z0);
  target.add(new THREE.Mesh(geo, fillMat));

  // Top sloped face outline
  pushSeg(primaryPts, x0, z0, x1, z0, yBack, yFront);
  pushSeg(primaryPts, x0, z1, x1, z1, yBack, yFront);
  pushSeg(primaryPts, x0, z0, x0, z1, yBack, yBack);
  pushSeg(primaryPts, x1, z0, x1, z1, yFront, yFront);
  // Base & side edges
  pushSeg(detailPts, x0, z0, x1, z0, yBase, yBase);
  pushSeg(detailPts, x0, z1, x1, z1, yBase, yBase);
  pushSeg(detailPts, x0, z0, x0, z1, yBase, yBase);
  pushSeg(detailPts, x1, z0, x1, z1, yBase, yBase);
  pushSeg(detailPts, x0, z0, x0, z0, yBase, yBack);
  pushSeg(detailPts, x0, z1, x0, z1, yBase, yBack);
  pushSeg(detailPts, x1, z0, x1, z0, yBase, yFront);
  pushSeg(detailPts, x1, z1, x1, z1, yBase, yFront);
}

/** Add subtle dashed collision footprint outline + corner ticks for modules whose visual overhangs collision bounds */
function addCollisionFootprintHint(
  collisionPts: number[],
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  y = 0.06
): void {
  const pad = 0.08;
  const bx0 = x0 + pad;
  const bx1 = x1 - pad;
  const bz0 = z0 + pad;
  const bz1 = z1 - pad;
  pushSeg(collisionPts, bx0, bz0, bx1, bz0, y);
  pushSeg(collisionPts, bx1, bz0, bx1, bz1, y);
  pushSeg(collisionPts, bx1, bz1, bx0, bz1, y);
  pushSeg(collisionPts, bx0, bz1, bx0, bz0, y);
}

export function buildShipModuleArt(
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
  const unitM = getModuleUnitM(def);
  const lw = def.sizeUnits[0] * unitM;
  const ld = def.sizeUnits[1] * unitM;
  const hw = lw / 2;
  const hd = ld / 2;
  const [ox, oy] = getModuleOriginOffsetM(def);
  const isGhost = ghostTint !== undefined;
  const isBottomMount = getModuleFloorShift(def) > 0;

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
  const primaryColor = isGhost ? ghostTint : isSelected ? palette.lineSelected : palette.linePrimary;

  const primaryPts: number[] = [];
  const detailPts: number[] = [];
  const accentPts: number[] = [];
  const collisionPts: number[] = [];
  let accentColor: number | null = null;
  let roofHeight = Math.max(2.6, Math.min(8.2, def.heightSpanM * 0.92));

  // Map actor-local (ax, az) into module-centered frame
  const lx = (ax: number) => ax - ox;
  const lz = (az: number) => az - oy;
  // Low flush mount vertical helper (top mounts hug y=0 deck, _B bottom mounts hug y=3.95 ceiling below hull!)
  const vy = (y0: number, y1: number): [number, number] =>
    isBottomMount ? [Math.max(0.15, 3.95 - y1), Math.max(0.35, 3.95 - y0)] : [y0, y1];

  const id = def.id;

  // =========================================================================
  // 1. COCKPITS & BRIDGES (real tapered short noses & wide cruiser bridge!)
  // =========================================================================
  if (id === 'BPO_Cockpit_01') {
    // Real mesh: X[-4.01..1.38], Y[-4..4], Z[-0.46..3.18] — compact short nose leaving front 2.6m open!
    roofHeight = 3.25;
    accentColor = palette.researchTint;
    const xRear = lx(-3.95);
    const xMid = lx(-0.85);
    const xNose = lx(1.38);
    const hullLoop: Array<[number, number]> = [
      [xRear, -3.75],
      [xMid, -3.35],
      [xNose, -1.75],
      [xNose, 1.75],
      [xMid, 3.35],
      [xRear, 3.75],
    ];
    addExtrudedLoop(extrudeGroup, hullLoop, 0, 2.05, fillBase, primaryPts, detailPts);
    const canopyLoop: Array<[number, number]> = [
      [lx(-3.2), -2.45],
      [lx(-0.9), -2.25],
      [lx(0.85), -1.35],
      [lx(0.85), 1.35],
      [lx(-0.9), 2.25],
      [lx(-3.2), 2.45],
    ];
    addExtrudedLoop(extrudeGroup, canopyLoop, 2.05, roofHeight, fillUpper, primaryPts, detailPts);
    // Panoramic forward glass mullions
    pushSeg(accentPts, lx(0.85), -1.35, xNose, -1.65, roofHeight, 2.05);
    pushSeg(accentPts, lx(0.85), 1.35, xNose, 1.65, roofHeight, 2.05);
    pushSeg(accentPts, lx(0.85), -1.35, lx(0.85), 1.35, roofHeight + 0.03);
    pushSeg(accentPts, lx(0.85), 0, xNose, 0, roofHeight, 2.05);
  } else if (id === 'BPO_Cockpit_02') {
    // Real mesh: 2x2x2, X[-8..4.27], Y[-8..8], Z[-0.84..6.06] — wide octagonal bridge stepping down to curved glass bow
    roofHeight = 6.1;
    accentColor = palette.researchTint;
    const hullLoop: Array<[number, number]> = [
      [lx(-7.9), -7.75],
      [lx(-1.2), -7.75],
      [lx(4.25), -3.8],
      [lx(4.25), 3.8],
      [lx(-1.2), 7.75],
      [lx(-7.9), 7.75],
    ];
    addExtrudedLoop(extrudeGroup, hullLoop, 0, 3.85, fillBase, primaryPts, detailPts, { verticalToPrimary: true });
    const crownLoop: Array<[number, number]> = [
      [lx(-6.8), -5.4],
      [lx(-1.4), -5.4],
      [lx(2.4), -2.8],
      [lx(2.4), 2.8],
      [lx(-1.4), 5.4],
      [lx(-6.8), 5.4],
    ];
    addExtrudedLoop(extrudeGroup, crownLoop, 3.85, roofHeight, fillUpper, primaryPts, detailPts);
    // Wraparound bridge glass canopy lines
    pushSeg(accentPts, lx(2.4), -2.8, lx(4.25), -3.7, roofHeight, 3.85);
    pushSeg(accentPts, lx(2.4), 2.8, lx(4.25), 3.7, roofHeight, 3.85);
    pushSeg(accentPts, lx(2.4), -2.8, lx(2.4), 2.8, roofHeight + 0.04);
    pushSeg(accentPts, lx(2.4), 0, lx(4.25), 0, roofHeight, 3.85);
  } else if (id === 'BPO_Cockpit_03') {
    // Real mesh: col 20x16x8 (X[-12..8], Y[-8..8]), visual WIDE winged cruiser bridge X[-12..11.98], Y[-11.8..11.8]!
    roofHeight = 5.45;
    accentColor = palette.researchTint;
    const hullLoop: Array<[number, number]> = [
      [lx(-11.95), -11.5],
      [lx(0.5), -11.5],
      [lx(11.85), -5.2],
      [lx(11.85), 5.2],
      [lx(0.5), 11.5],
      [lx(-11.95), 11.5],
    ];
    addExtrudedLoop(extrudeGroup, hullLoop, 0, 3.45, fillBase, primaryPts, detailPts, { verticalToPrimary: true });
    const deckLoop: Array<[number, number]> = [
      [lx(-10.5), -7.6],
      [lx(0.2), -7.6],
      [lx(8.6), -3.8],
      [lx(8.6), 3.8],
      [lx(0.2), 7.6],
      [lx(-10.5), 7.6],
    ];
    addExtrudedLoop(extrudeGroup, deckLoop, 3.45, roofHeight, fillUpper, primaryPts, detailPts);
    // Swept panoramic bridge visor
    pushSeg(accentPts, lx(8.6), -3.8, lx(11.85), -5.1, roofHeight, 3.45);
    pushSeg(accentPts, lx(8.6), 3.8, lx(11.85), 5.1, roofHeight, 3.45);
    pushSeg(accentPts, lx(8.6), -3.8, lx(8.6), 3.8, roofHeight + 0.04);
    pushSeg(accentPts, lx(0.2), -7.6, lx(0.5), -11.5, roofHeight, 3.45);
    pushSeg(accentPts, lx(0.2), 7.6, lx(0.5), 11.5, roofHeight, 3.45);
    // Dashed collision footprint (exact 20x16m BlockBounds inside the wider 24x23.6m visual bridge)
    addCollisionFootprintHint(collisionPts, lx(-12), lx(8), lz(-8), lz(8));

  // =========================================================================
  // 2. HULLS, CORNERS, WINDOWS, OPEN CROSS-FRAMES & LADDER
  // =========================================================================
  } else if (id === 'BPO_Body_01' || id === 'BPO_Body_02') {
    roofHeight = 3.55;
    addBox(extrudeGroup, 0, 0, hw - 0.12, hd - 0.12, 0, roofHeight, fillBase, primaryPts, detailPts, 0.55);
    // Real outer frame collar + recessed central rounded hatch panel
    pushLoop(detailPts, getChamferLoop(hw - 1.35, hd - 1.35, 0.65), roofHeight + 0.02);
    for (const s of [-1, 1]) {
      pushSeg(detailPts, s * (hw - 0.15), -1.8, s * (hw - 1.25), -1.8, roofHeight + 0.02);
      pushSeg(detailPts, s * (hw - 0.15), 1.8, s * (hw - 1.25), 1.8, roofHeight + 0.02);
    }
    if (id === 'BPO_Body_02') {
      // Recessed panoramic window strip along +Z face
      accentColor = palette.researchTint;
      pushSeg(accentPts, -3.05, hd - 0.14, 3.05, hd - 0.14, roofHeight - 0.25);
      pushSeg(accentPts, -3.05, hd - 0.14, 3.05, hd - 0.14, 0.65);
      for (const wx of [-3.05, -1.0, 1.0, 3.05]) {
        pushSeg(accentPts, wx, hd - 0.14, wx, hd - 0.14, 0.65, roofHeight - 0.25);
      }
    }
  } else if (id === 'BPO_ShipCorner_01') {
    // Real chamfered corner cabin with large panoramic diagonal glass along (+X,+Z)
    roofHeight = 3.55;
    accentColor = palette.researchTint;
    const loop: Array<[number, number]> = [
      [-hw + 0.14, -hd + 0.14],
      [hw - 0.14, -hd + 0.14],
      [hw - 0.14, -hd + 2.3],
      [-hw + 2.3, hd - 0.14],
      [-hw + 0.14, hd - 0.14],
    ];
    addExtrudedLoop(extrudeGroup, loop, 0, roofHeight, fillBase, primaryPts, detailPts);
    // Diagonal panoramic window mullions
    pushSeg(accentPts, hw - 0.2, -hd + 2.35, -hw + 2.35, hd - 0.2, roofHeight - 0.2);
    pushSeg(accentPts, hw - 0.2, -hd + 2.35, -hw + 2.35, hd - 0.2, 0.6);
    pushSeg(accentPts, 0.9, -0.9, 0.9, -0.9, 0.6, roofHeight - 0.2);
  } else if (id === 'BPO_WindowBlock') {
    // Real compact protruding viewport bay: X[0..1.7], Y[-1.63..1.61], Z[0..2.43]
    roofHeight = 2.45;
    accentColor = palette.researchTint;
    const x0 = lx(0.05);
    const x1 = lx(1.7);
    const loop: Array<[number, number]> = [
      [x0, -1.62],
      [x1 - 0.45, -1.62],
      [x1, -1.05],
      [x1, 1.05],
      [x1 - 0.45, 1.62],
      [x0, 1.62],
    ];
    addExtrudedLoop(extrudeGroup, loop, 0.1, roofHeight, fillUpper, primaryPts, detailPts);
    pushSeg(accentPts, x1, -1.05, x1, 1.05, 0.45);
    pushSeg(accentPts, x1, -1.05, x1, 1.05, roofHeight - 0.35);
    pushSeg(accentPts, x1, 0, x1, 0, 0.45, roofHeight - 0.35);
  } else if (id === 'BPO_Frame_01') {
    // Real open cross-shaped (+) structural girder corridor (all 4 corners cleanly open!)
    roofHeight = 3.25;
    const arm = 1.65;
    const e = hw - 0.12;
    const crossLoop: Array<[number, number]> = [
      [-arm, -e], [arm, -e], [arm, -arm],
      [e, -arm], [e, arm], [arm, arm],
      [arm, e], [-arm, e], [-arm, arm],
      [-e, arm], [-e, -arm], [-arm, -arm],
    ];
    addExtrudedLoop(extrudeGroup, crossLoop, 0.15, roofHeight, fillBase, primaryPts, detailPts);
    pushLoop(detailPts, getChamferLoop(1.25, 1.25, 0.35), roofHeight + 0.02);
    // Open truss diagonal cross-bracing along each arm
    for (const s of [-1, 1]) {
      pushSeg(detailPts, s * 1.65, -arm, s * e, arm, roofHeight + 0.02);
      pushSeg(detailPts, -arm, s * 1.65, arm, s * e, roofHeight + 0.02);
    }
  } else if (id === 'BPO_FrameSlope_01T' || id === 'BPO_FrameSlope_01B') {
    // Real cantilever open triangular truss: connector flange on -X (-4..-2.8), tapering to +2.0!
    const isBot = id === 'BPO_FrameSlope_01B';
    roofHeight = 3.15;
    const loop: Array<[number, number]> = [
      [lx(-3.95), -1.95],
      [lx(-2.2), -1.95],
      [lx(1.95), -1.35],
      [lx(1.95), 1.35],
      [lx(-2.2), 1.95],
      [lx(-3.95), 1.95],
    ];
    addExtrudedLoop(extrudeGroup, loop, isBot ? 1.85 : 0.1, isBot ? roofHeight : 1.55, fillBase, primaryPts, detailPts);
    // Sloping triangular cantilever girder struts
    const yRear = isBot ? 0.25 : 2.95;
    const yTip = isBot ? 2.65 : 0.85;
    for (const sz of [-1.2, 1.2]) {
      pushSeg(primaryPts, lx(-3.8), sz, lx(1.9), sz * 0.8, yRear, yTip);
      pushSeg(detailPts, lx(-3.8), sz, lx(-3.8), sz, 0.15, roofHeight);
    }
    pushSeg(primaryPts, lx(-3.8), -1.2, lx(-3.8), 1.2, yRear, yRear);
    pushSeg(primaryPts, lx(1.9), -0.96, lx(1.9), 0.96, yTip, yTip);
  } else if (id === 'BPO_LadderBlock') {
    roofHeight = 7.4;
    addBox(extrudeGroup, 0, 0, hw - 0.14, hd - 0.14, 0, roofHeight, fillBase, primaryPts, detailPts, 0.55, true);
    pushLoop(primaryPts, getChamferLoop(1.45, 1.45, 0.35), roofHeight + 0.03);
    for (let ry = 1.2; ry < roofHeight; ry += 1.4) {
      pushSeg(detailPts, -0.95, -1.2, 0.95, -1.2, ry, ry);
    }

  // =========================================================================
  // 3. THRUSTERS (true elongated overhangs + dashed collision footprints!)
  // =========================================================================
  } else if (id === 'BPO_Thruster_02R' || id === 'BPO_Thruster_02L') {
    // Real mesh: 13.2m long (X[-10.0..3.18]), side-mounted pod overhanging -6m behind 8x8 collision cell!
    const isLeft = id === 'BPO_Thruster_02L';
    const sz = isLeft ? 1 : -1; // Mount side: +Z for L, -Z for R
    roofHeight = 2.85;
    const xFront = lx(3.15);
    const xRearBody = lx(-7.2);
    const zMount = sz * 3.92;
    const zOuter = sz * -1.78;
    const zMid = (zMount + zOuter) / 2;
    const podLoop: Array<[number, number]> = [
      [xFront, zMount],
      [xFront - 1.4, zOuter + sz * 0.5],
      [lx(-0.6), zOuter],
      [xRearBody, zOuter + sz * 0.35],
      [xRearBody, zMount - sz * 0.65],
      [lx(-3.5), zMount],
    ];
    addExtrudedLoop(extrudeGroup, podLoop, 0.25, roofHeight, fillBase, primaryPts, detailPts);
    // Twin stepped aft exhaust cones reaching X = -10.0m!
    addAftNozzle(extrudeGroup, xRearBody, lx(-10.0), zMid - sz * 0.95, 1.45, 0.95, 0.42, fillUpper, primaryPts, detailPts, 8);
    addAftNozzle(extrudeGroup, xRearBody + 0.9, lx(-8.95), zMid + sz * 0.85, 1.45, 0.88, 0.4, fillUpper, primaryPts, detailPts, 8);
    // Clear dashed 8x8m 1-cell collision footprint so player immediately sees collision = 1 block!
    addCollisionFootprintHint(collisionPts, -hw, hw, -hd, hd);
  } else if (id === 'BPO_Thruster_04R' || id === 'BPO_Thruster_04L') {
    // Real mesh: 18.0m ULTRA-LONG Relic Thruster (X[-14.61..3.40]) — 2.25 blocks long visually, 1 block collision!
    const isLeft = id === 'BPO_Thruster_04L';
    const sz = isLeft ? 1 : -1;
    roofHeight = 3.15;
    accentColor = palette.researchTint;
    const xFront = lx(3.38);
    const xCoreRear = lx(-8.4);
    const xFinTip = lx(-14.55);
    const zMount = sz * 3.95;
    const zOuter = sz * -3.65;
    const zCenter = sz * 0.15;
    // Sleek elongated forward nacelle + split swept relic tail fairing
    const bodyLoop: Array<[number, number]> = [
      [xFront, zMount],
      [xFront - 1.8, zOuter + sz * 1.1],
      [lx(-0.8), zOuter],
      [xFinTip, zOuter + sz * 0.9],
      [xCoreRear, zCenter - sz * 0.6],
      [xCoreRear, zCenter + sz * 1.1],
      [lx(-12.2), zMount - sz * 0.4],
      [lx(-4.0), zMount],
    ];
    addExtrudedLoop(extrudeGroup, bodyLoop, 0.15, roofHeight, fillBase, primaryPts, detailPts);
    // Twin staggered relic aft exhaust cones + glowing cyan relic conduit ridges
    addAftNozzle(extrudeGroup, xCoreRear, lx(-13.6), zCenter - sz * 1.15, 1.55, 1.05, 0.42, fillUpper, primaryPts, detailPts, 6);
    addAftNozzle(extrudeGroup, xCoreRear + 0.8, lx(-11.8), zCenter + sz * 1.15, 1.55, 0.98, 0.4, fillUpper, primaryPts, detailPts, 6);
    pushSeg(accentPts, lx(1.2), zCenter, xCoreRear, zCenter, roofHeight + 0.04);
    pushSeg(accentPts, lx(-2.5), zOuter + sz * 0.7, xFinTip + 0.4, zOuter + sz * 1.0, roofHeight + 0.04);
    pushSeg(accentPts, lx(-4.2), zMount - sz * 0.5, lx(-11.8), zMount - sz * 0.5, roofHeight + 0.04);
    // Crucial dashed 8x8m 1-cell collision footprint showing 1-block collision vs 2.25-block visual length!
    addCollisionFootprintHint(collisionPts, -hw, hw, -hd, hd);
  } else if (id === 'BPO_Thruster_03') {
    // Real mesh: 2x1x2 (16x8x10m), X[-12..4], Y[-4..4] — armored double-deck housing + vertically stacked twin exhausts
    roofHeight = 7.8;
    const xFront = lx(3.95);
    const xBodyRear = lx(-7.2);
    const loop: Array<[number, number]> = [
      [xFront, -3.5],
      [xFront, 3.5],
      [lx(-1.5), 3.85],
      [xBodyRear, 3.3],
      [xBodyRear, -3.3],
      [lx(-1.5), -3.85],
    ];
    addExtrudedLoop(extrudeGroup, loop, 0, roofHeight, fillBase, primaryPts, detailPts, { verticalToPrimary: true });
    // Two vertically stacked large aft cones extending to X = -12.0m
    addAftNozzle(extrudeGroup, xBodyRear, lx(-12.0), 0, 2.2, 2.0, 0.95, fillUpper, primaryPts, detailPts, 10);
    addAftNozzle(extrudeGroup, xBodyRear, lx(-12.0), 0, 5.8, 2.0, 0.95, fillUpper, primaryPts, detailPts, 10);
    pushSeg(detailPts, lx(2.5), 0, xBodyRear, 0, roofHeight + 0.03);
  } else if (id === 'BPO_Thruster_05') {
    // Real mesh: 2x3x2 (16x24x10m), X[-12.76..4.04], Y[-11.79..11.79] — colossal wide capital engine with 3-bank twin-stack nozzles!
    roofHeight = 8.0;
    const xFront = lx(3.95);
    const xBodyRear = lx(-5.8);
    addBox(extrudeGroup, (xFront + xBodyRear) / 2, 0, (xFront - xBodyRear) / 2, hd - 0.35, 0, roofHeight, fillBase, primaryPts, detailPts, 1.35, true);
    for (const nz of [-7.6, 0, 7.6]) {
      const rF = nz === 0 ? 2.45 : 2.15;
      addAftNozzle(extrudeGroup, xBodyRear, lx(-12.7), nz, 2.25, rF, 1.05, fillUpper, primaryPts, detailPts, 10);
      addAftNozzle(extrudeGroup, xBodyRear, lx(-12.7), nz, 5.85, rF, 1.05, fillUpper, primaryPts, detailPts, 10);
    }
    pushSeg(detailPts, xFront - 1.2, -4.2, xBodyRear + 0.4, -4.2, roofHeight + 0.03);
    pushSeg(detailPts, xFront - 1.2, 4.2, xBodyRear + 0.4, 4.2, roofHeight + 0.03);
    addCollisionFootprintHint(collisionPts, lx(-12), lx(4), -hd, hd);

  // =========================================================================
  // 4. REACTOR vs WARP DRIVE (real D-shaped semicircular hulls: solid core vs hollow ring!)
  // =========================================================================
  } else if (id === 'BPO_ReactorBlock_Small') {
    // Real mesh: X[-3.19..4.01], Y[-4..4], Z[-1.56..3.29] — D-shaped semicircular dome (+X flat bow, -X semicircle) + solid circular cap!
    roofHeight = 3.55;
    accentColor = palette.powerTint;
    const dLoop = makeDLoop(lx(3.95), lx(0.65), 3.82, 3.88, 12);
    addExtrudedLoop(extrudeGroup, dLoop, 0, 2.65, fillBase, primaryPts, detailPts, { skipVertStep: 2 });
    // Solid circular fusion containment cap (warm champagne gold accent — distinct from Warp's huge HOLLOW ring!)
    addDrum(extrudeGroup, lx(0.95), 0, 2.15, 1.75, 12, 2.65, roofHeight, 0, fillUpper, primaryPts, detailPts, 6);
    pushPolygon(accentPts, 1.72, 12, roofHeight + 0.04, 0, lx(0.95), 0);
    pushPolygon(accentPts, 0.75, 6, roofHeight + 0.05, 0, lx(0.95), 0);
    // Radial heat-sink spokes around the semicircular dome
    for (const ang of [Math.PI * 0.65, Math.PI, Math.PI * 1.35]) {
      pushSeg(
        accentPts,
        lx(0.95) + Math.cos(ang) * 1.85,
        Math.sin(ang) * 1.85,
        lx(0.65) + Math.cos(ang) * 3.7,
        Math.sin(ang) * 3.75,
        roofHeight - 0.25,
        2.7
      );
    }
  } else if (id === 'BPO_WarpDriveBlock') {
    // Real mesh: X[-3.76..4.01], Y[-4..4], Z[-0.84..3.15] — D-shaped semicircular hull dominated by a MASSIVE HOLLOW TOROIDAL RING!
    roofHeight = 3.45;
    accentColor = palette.researchTint;
    const ringCx = lx(0.15);
    const dLoop = makeDLoop(lx(3.95), ringCx, 3.88, 3.88, 14);
    // Extrude D-hull WITH a genuine open central hole matching the real hollow warp ring!
    addExtrudedLoop(extrudeGroup, dLoop, 0, 2.25, fillBase, primaryPts, detailPts, {
      skipVertStep: 2,
      holeRadius: 1.65,
      holeCx: ringCx,
      holeCz: 0,
    });
    // Raised segmented toroidal warp coil collar surrounding the hollow center
    const outerLoop: Array<[number, number]> = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      outerLoop.push([ringCx + Math.cos(a) * 3.35, Math.sin(a) * 3.35]);
    }
    addExtrudedLoop(extrudeGroup, outerLoop, 2.25, roofHeight, fillUpper, primaryPts, detailPts, {
      skipVertStep: 2,
      holeRadius: 1.72,
      holeCx: ringCx,
      holeCz: 0,
    });
    // Crisp cool cyan toroidal coil rings & radial field ribs (zero confusion with solid gold Reactor!)
    pushPolygon(accentPts, 3.32, 16, roofHeight + 0.04, 0, ringCx, 0);
    pushPolygon(accentPts, 1.72, 16, roofHeight + 0.04, 0, ringCx, 0);
    pushPolygon(detailPts, 1.72, 16, 0.15, 0, ringCx, 0);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      pushSeg(
        accentPts,
        ringCx + Math.cos(a) * 1.75,
        Math.sin(a) * 1.75,
        ringCx + Math.cos(a) * 3.32,
        Math.sin(a) * 3.32,
        roofHeight + 0.03
      );
    }
  } else if (id === 'BPO_InterstellarWarpDriveBlock') {
    // Real mesh: 2x3x2 (16x24x8m) rectangular chassis with central large circular hollow warp core + twin arched dorsal rings
    roofHeight = 6.6;
    accentColor = palette.researchTint;
    addBox(extrudeGroup, 0, 0, hw - 0.25, hd - 0.25, 0, 3.4, fillBase, primaryPts, detailPts, 1.1, true);
    const ringLoop: Array<[number, number]> = [];
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      ringLoop.push([Math.cos(a) * 5.8, Math.sin(a) * 5.8]);
    }
    addExtrudedLoop(extrudeGroup, ringLoop, 3.4, 5.4, fillUpper, primaryPts, detailPts, {
      skipVertStep: 3,
      holeRadius: 3.1,
    });
    pushPolygon(accentPts, 5.8, 18, 5.45);
    pushPolygon(accentPts, 3.1, 18, 5.45);
    // Flanking dorsal stabilizer bridges along ±Z
    for (const sz of [-1, 1]) {
      addBox(extrudeGroup, 0, sz * 8.6, 5.2, 1.85, 3.4, 4.9, fillUpper, primaryPts, detailPts, 0.4);
      pushSeg(accentPts, -4.6, sz * 8.6, 4.6, sz * 8.6, 4.95);
    }
    // Elevated vertical cross-arch over the singularity core
    pushArc(accentPts, 0, 0, 4.4, 0, Math.PI * 2, 16, roofHeight);

  // =========================================================================
  // 5. LOW FLUSH ROOF/BELLY ATTACHMENTS (Weapons, Mining, Tractor, PD, Shield)
  // =========================================================================
  } else if (id.startsWith('BPO_CannonBlock')) {
    // Real mesh: low flush mount Z[-0.85..0.65], compact turret + TWO LONG THICK BARRELS protruding to X=+4.64m!
    const [b0, b1] = vy(0.02, 0.72);
    const [t0, t1] = vy(0.72, 1.48);
    roofHeight = Math.max(b1, t1);
    accentColor = palette.turretTint;
    addBox(extrudeGroup, lx(-0.8), 0, 2.0, 2.22, b0, b1, fillBase, primaryPts, detailPts, 0.55);
    addBox(extrudeGroup, lx(-0.65), 0, 1.65, 1.55, t0, t1, fillUpper, primaryPts, detailPts, 0.4);
    // Twin thick parallel barrels extending past +4m cell boundary to +4.64m!
    const by0 = (t0 + t1) * 0.5 - 0.24;
    const by1 = (t0 + t1) * 0.5 + 0.24;
    for (const bz of [-1.08, 1.08]) {
      addBox(extrudeGroup, lx(2.55), bz, 2.1, 0.36, by0, by1, fillUpper, primaryPts, detailPts, 0.08);
      pushSeg(accentPts, lx(0.6), bz, lx(4.64), bz, by1 + 0.03);
    }
  } else if (id.startsWith('BPO_MiningLaserBlock')) {
    // Real mesh: low flush mount Z[-0.85..1.88], rear generator + SINGLE THICK CENTRAL BARREL to +4.45m with 3 dorsal fins!
    const [b0, b1] = vy(0.02, 0.85);
    const [, t1] = vy(0.85, 1.85);
    roofHeight = Math.max(b1, t1);
    accentColor = palette.powerTint;
    addBox(extrudeGroup, lx(-0.45), 0, 2.05, 2.2, b0, b1, fillBase, primaryPts, detailPts, 0.45);
    // Single thick central industrial laser bore reaching +4.45m
    addBox(extrudeGroup, lx(1.95), 0, 2.5, 0.78, (b0 + b1) * 0.5, t1 - 0.15, fillUpper, primaryPts, detailPts, 0.25);
    // 3 dorsal angled cooling fins across rear housing
    for (const fx of [-1.6, -0.7, 0.2]) {
      pushSeg(accentPts, lx(fx), -1.35, lx(fx), 1.35, t1 + 0.03);
    }
    pushSeg(accentPts, lx(0.8), 0, lx(4.45), 0, t1 - 0.12);
  } else if (id.startsWith('BPO_TractorBeamBlock')) {
    // Real mesh: low flush mount Z[-0.85..0.73], compact beveled base X[-2.28..3.16], Y[-2.28..2.28] + centered circular emitter!
    const [b0, b1] = vy(0.02, 0.78);
    const [t0, t1] = vy(0.78, 1.42);
    roofHeight = Math.max(b1, t1);
    accentColor = palette.solarTint;
    addBox(extrudeGroup, lx(0.45), 0, 2.68, 2.22, b0, b1, fillBase, primaryPts, detailPts, 0.6);
    addDrum(extrudeGroup, lx(0.35), 0, 1.55, 1.35, 12, t0, t1, 0, fillUpper, primaryPts, detailPts, 4);
    pushPolygon(accentPts, 1.15, 12, t1 + 0.04, 0, lx(0.35), 0);
    pushPolygon(accentPts, 0.55, 8, t1 + 0.05, 0, lx(0.35), 0);
  } else if (id.startsWith('BPO_ShipLaserTurretBlock')) {
    // Real mesh: low flush mount Z[-0.85..0.65], ICONIC 6-PETAL RADIAL STAR PD TURRET (X[-3.16..3.16], Y[-2.34..2.34])!
    const [b0, b1] = vy(0.02, 0.62);
    const [t0, t1] = vy(0.62, 1.32);
    roofHeight = Math.max(b1, t1);
    accentColor = palette.turretTint;
    addDrum(extrudeGroup, 0, 0, 2.25, 1.95, 12, b0, b1, 0, fillBase, primaryPts, detailPts, 6);
    // 6 radial star micro-emitter pods around open central core
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      const px = Math.cos(a) * 2.15;
      const pz = Math.sin(a) * 1.9;
      addDrum(extrudeGroup, px, pz, 0.65, 0.52, 6, t0, t1, a, fillUpper, primaryPts, detailPts, 2);
      pushSeg(accentPts, Math.cos(a) * 1.1, Math.sin(a) * 1.0, Math.cos(a) * 2.85, Math.sin(a) * 2.45, t1 + 0.03);
    }
    pushPolygon(accentPts, 1.05, 6, t1 + 0.03);
  } else if (id.startsWith('BPO_ShipShieldGenerator_01')) {
    // Real mesh: low flush mount Z[-0.85..1.07], FLAT HORIZONTAL X-BRACED TWIN-TRUSS EMITTER FRAME (X[-3.83..3.83], Y[-2.28..2.28])!
    const [b0, b1] = vy(0.02, 0.78);
    const [t0, t1] = vy(0.78, 1.52);
    roofHeight = Math.max(b1, t1);
    accentColor = palette.solarTint;
    addBox(extrudeGroup, 0, 0, 3.78, 2.22, b0, b1, fillBase, primaryPts, detailPts, 0.65);
    // Twin parallel longitudinal field rails + crisp X-bracing coils matching real mesh!
    for (const sz of [-1.45, 1.45]) {
      addBox(extrudeGroup, 0, sz, 3.25, 0.45, t0, t1, fillUpper, primaryPts, detailPts, 0.15);
    }
    pushSeg(accentPts, -3.1, -1.45, 3.1, 1.45, t1 + 0.04);
    pushSeg(accentPts, -3.1, 1.45, 3.1, -1.45, t1 + 0.04);
    pushSeg(accentPts, -3.4, 0, 3.4, 0, t1 + 0.03);
    for (const fx of [-2.1, 0, 2.1]) {
      pushSeg(accentPts, fx, -1.75, fx, 1.75, t1 + 0.03);
    }
  } else if (id === 'BPO_LanceBlock') {
    // Real mesh: 32m (4x1) SLEEK NARROW SPINAL RAILGUN — rear breech + long slim accelerator barrel!
    roofHeight = 3.2;
    accentColor = palette.turretTint;
    // Rear power breech block (X[-15.5..-8.5])
    addBox(extrudeGroup, lx(-12.0), 0, 3.5, 2.55, 0.15, roofHeight, fillBase, primaryPts, detailPts, 0.55);
    // Mid capacitor housing (X[-8.5..-1.5])
    addBox(extrudeGroup, lx(-5.0), 0, 3.6, 1.65, 0.35, 2.75, fillBase, primaryPts, detailPts, 0.35);
    // Long slender spinal accelerator barrel running to muzzle X=+15.9m!
    addBox(extrudeGroup, lx(7.2), 0, 8.7, 0.92, 0.65, 2.35, fillUpper, primaryPts, detailPts, 0.2);
    // Magnetic accelerator ring coils along the barrel
    for (let rx = -1.0; rx <= 14.5; rx += 3.0) {
      pushSeg(accentPts, lx(rx), -1.15, lx(rx), 1.15, 2.4);
    }
    pushSeg(accentPts, lx(-8.0), 0, lx(15.9), 0, 2.42);
  } else if (id === 'BPO_MissileLauncherBlock_01') {
    // Real mesh: 1x1x2 (8x8x8m) heavy vertical block with recessed 2x2 quad missile silos
    roofHeight = 6.6;
    accentColor = palette.turretTint;
    addBox(extrudeGroup, 0, 0, hw - 0.16, hd - 0.16, 0, roofHeight, fillBase, primaryPts, detailPts, 0.6, true);
    pushLoop(detailPts, getChamferLoop(2.65, 2.65, 0.35), roofHeight + 0.02);
    for (const sx of [-1.2, 1.2]) {
      for (const sz of [-1.2, 1.2]) {
        pushPolygon(primaryPts, 0.85, 10, roofHeight + 0.04, 0, sx, sz);
        pushPolygon(accentPts, 0.42, 8, roofHeight + 0.05, 0, sx, sz);
      }
    }

  // =========================================================================
  // 6. ARMOUR WINGS & TRUE SLOPED ARMOUR WEDGES
  // =========================================================================
  } else if (id === 'BPO_Armour_01R' || id === 'BPO_Armour_01L') {
    // Real mesh: 16x4m aerodynamic side armour wing hugging hull edge with curved bow taper & rear notch
    const isLeft = id === 'BPO_Armour_01L';
    const sz = isLeft ? 1 : -1;
    roofHeight = 2.65;
    const zBase = sz * (hd - 0.12);
    const zTip = -sz * (hd - 0.35);
    const wingLoop: Array<[number, number]> = [
      [-hw + 0.15, zBase],
      [hw - 0.15, zBase],
      [hw - 1.2, zBase - sz * 1.1],
      [hw - 4.8, zTip],
      [-hw + 3.2, zTip],
      [-hw + 0.9, zBase - sz * 1.5],
    ];
    addExtrudedLoop(extrudeGroup, wingLoop, 0.15, roofHeight, fillBase, primaryPts, detailPts);
    pushSeg(detailPts, -hw + 3.5, (zBase + zTip) * 0.5, hw - 4.2, (zBase + zTip) * 0.5, roofHeight + 0.02);
  } else if (id.startsWith('BPO_ArmourSlope_')) {
    // Real mesh: true wedge-shaped sloped armour plate (1x1 or 2x1, top slope T or inverted underside slope B)!
    const isBot = id.endsWith('B');
    roofHeight = 3.2;
    if (!isBot) {
      addSlopedWedge(
        extrudeGroup,
        -hw + 0.12,
        hw - 0.12,
        -hd + 0.12,
        hd - 0.12,
        0.05,
        3.2,
        0.65,
        fillBase,
        primaryPts,
        detailPts
      );
      pushSeg(detailPts, 0, -hd + 0.25, 0, hd - 0.25, 1.9);
    } else {
      // Inverted underside wedge: flat top at y=3.2, sloping underside from y=0.1 (-X) to y=2.55 (+X)
      const x0 = -hw + 0.12;
      const x1 = hw - 0.12;
      const z0 = -hd + 0.12;
      const z1 = hd - 0.12;
      const shape = new THREE.Shape();
      shape.moveTo(x0, 3.2);
      shape.lineTo(x1, 3.2);
      shape.lineTo(x1, 2.55);
      shape.lineTo(x0, 0.15);
      shape.closePath();
      const geo = new THREE.ExtrudeGeometry(shape, { depth: z1 - z0, bevelEnabled: false, curveSegments: 1 });
      geo.translate(0, 0, z0);
      extrudeGroup.add(new THREE.Mesh(geo, fillBase));
      pushLoop(primaryPts, [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], 3.21);
      pushSeg(primaryPts, x0, z0, x1, z0, 0.15, 2.55);
      pushSeg(primaryPts, x0, z1, x1, z1, 0.15, 2.55);
      pushSeg(detailPts, x0, z0, x0, z1, 0.15, 0.15);
      pushSeg(detailPts, x1, z0, x1, z1, 2.55, 2.55);
      pushSeg(detailPts, x0, z0, x0, z0, 0.15, 3.2);
      pushSeg(detailPts, x0, z1, x0, z1, 0.15, 3.2);
      pushSeg(detailPts, x1, z0, x1, z0, 2.55, 3.2);
      pushSeg(detailPts, x1, z1, x1, z1, 2.55, 3.2);
      pushSeg(detailPts, 0, -hd + 0.25, 0, hd - 0.25, 3.22);
    }

  // =========================================================================
  // 7. UTILITY MODULES (Docking Collar, Workstation, Container, Gear, Hangar, Scanners)
  // =========================================================================
  } else if (id === 'BPO_DockingCollar') {
    // Real mesh: half-depth 8x4m (Y[-4..0]) trapezoidal protruding airlock bay!
    roofHeight = 3.35;
    const loop: Array<[number, number]> = [
      [-hw + 0.15, lz(-3.95)],
      [hw - 0.15, lz(-3.95)],
      [hw - 1.1, lz(-0.15)],
      [-hw + 1.1, lz(-0.15)],
    ];
    addExtrudedLoop(extrudeGroup, loop, 0, roofHeight, fillBase, primaryPts, detailPts);
    pushLoop(primaryPts, getChamferLoop(1.65, 0.95, 0.45, 0, lz(-2.1)), roofHeight + 0.03);
    pushSeg(detailPts, -1.2, lz(-2.1), 1.2, lz(-2.1), roofHeight + 0.04);
  } else if (id === 'BPO_WorkstationBlock') {
    // Real mesh: half-depth 8x4m (Y[0.13..4.0]) trapezoidal side cabin!
    roofHeight = 3.3;
    const loop: Array<[number, number]> = [
      [-hw + 0.15, lz(3.95)],
      [hw - 0.15, lz(3.95)],
      [hw - 1.1, lz(0.2)],
      [-hw + 1.1, lz(0.2)],
    ];
    addExtrudedLoop(extrudeGroup, loop, 0, roofHeight, fillBase, primaryPts, detailPts);
    pushPolygon(primaryPts, 1.0, 8, roofHeight + 0.03, 0, 0, lz(2.15));
  } else if (id === 'BPO_ShipContainerBlock') {
    // Real mesh: TWO PARALLEL RIBBED CARGO RACKS along ±Z separated by an open central walkway corridor!
    roofHeight = 3.25;
    for (const sz of [-2.65, 2.65]) {
      addBox(extrudeGroup, 0, sz, hw - 0.18, 1.22, 0.1, roofHeight, fillBase, primaryPts, detailPts, 0.2);
      for (let rx = -2.8; rx <= 2.8; rx += 1.4) {
        pushSeg(detailPts, rx, sz - 1.18, rx, sz + 1.18, roofHeight + 0.02);
      }
    }
    // Central floor walkway deck connecting the twin racks
    addBox(extrudeGroup, 0, 0, hw - 0.25, 1.35, 0, 0.45, fillUpper, primaryPts, detailPts, 0.1);
  } else if (id === 'BPO_LandingGear_01') {
    // Real mesh: central mounting transverse frame + twin outboard landing gear housings on ±Z
    roofHeight = 3.15;
    addBox(extrudeGroup, 0, 0, hw - 0.2, 1.15, 2.0, roofHeight, fillBase, primaryPts, detailPts, 0.25);
    for (const sz of [-2.45, 2.45]) {
      addBox(extrudeGroup, 0, sz, 1.65, 1.15, 0.25, roofHeight - 0.15, fillUpper, primaryPts, detailPts, 0.25);
    }
  } else if (id === 'BPO_Hangar_2') {
    // Real mesh: massive 24x32x8m armored ship hangar bay with recessed deck & twin docking markings
    roofHeight = 7.35;
    addBox(extrudeGroup, 0, 0, hw - 0.2, hd - 0.2, 0, roofHeight, fillBase, primaryPts, detailPts, 0.85, true);
    pushLoop(primaryPts, getChamferLoop(hw - 2.6, hd - 2.6, 0.5), roofHeight + 0.03);
    for (const sz of [-5.2, 5.2]) {
      pushLoop(detailPts, getChamferLoop(3.6, 1.15, 0.35, 0, sz), roofHeight + 0.04);
    }
  } else if (id === 'BPO_AstronomicScanner' || id === 'BPO_BiosampleCollector') {
    // Real mesh: 2x3x2 (16x24x8m) angled belly sensor/collector bays extending down to Z=-4.3/-5.3m, overhang +X=8.8m!
    const isBio = id === 'BPO_BiosampleCollector';
    roofHeight = 3.25;
    accentColor = isBio ? palette.powerTint : palette.researchTint;
    addBox(extrudeGroup, lx(0.1), 0, 7.85, 11.75, -2.8, roofHeight, fillBase, primaryPts, detailPts, 0.9, true);
    if (!isBio) {
      // Large forward (+X) concave circular scanner dish aperture
      pushArc(accentPts, lx(7.4), 0, 6.2, Math.PI * 0.58, Math.PI * 1.42, 12, roofHeight + 0.04);
      pushSeg(accentPts, lx(1.2), 0, lx(8.75), 0, roofHeight + 0.04);
      pushPolygon(accentPts, 2.1, 10, roofHeight + 0.04, 0, lx(4.6), 0);
    } else {
      // Multi-blade parallel biological collector tines protruding toward +X (+8.79m)
      for (let tz = -8.4; tz <= 8.4; tz += 2.8) {
        addBox(extrudeGroup, lx(5.8), tz, 2.95, 0.55, 0.4, roofHeight - 0.15, fillUpper, primaryPts, detailPts, 0.12);
        pushSeg(accentPts, lx(3.2), tz, lx(8.75), tz, roofHeight - 0.1);
      }
    }
    addCollisionFootprintHint(collisionPts, lx(-8), lx(8), lz(-12), lz(12));
  } else {
    roofHeight = 3.4;
    addBox(extrudeGroup, 0, 0, hw - 0.2, hd - 0.2, 0, roofHeight, fillBase, primaryPts, detailPts, 0.55);
  }

  if (primaryPts.length > 0) {
    extrudeGroup.add(
      createCrispLineSegments(primaryPts, {
        color: primaryColor,
        opacity: isGhost ? opacity * 0.94 : opacity,
        widthPx: isSelected ? 1.55 : 1.24,
        lodTier: 'primary',
      })
    );
  }
  if (accentPts.length > 0) {
    extrudeGroup.add(
      createCrispLineSegments(accentPts, {
        color: isGhost ? ghostTint : isSelected ? palette.lineSelected : (accentColor ?? palette.linePrimary),
        opacity: isGhost ? opacity * 0.9 : opacity,
        widthPx: isSelected ? 1.45 : 1.2,
        lodTier: 'primary',
      })
    );
  }
  if (detailPts.length > 0) {
    extrudeGroup.add(
      createCrispLineSegments(detailPts, {
        color: isGhost ? ghostTint : isSelected ? palette.linePrimary : palette.lineDetail,
        opacity: isGhost ? opacity * 0.62 : opacity,
        widthPx: 0.85,
        lodTier: 'detail',
      })
    );
  }
  if (collisionPts.length > 0) {
    // Subtle dashed collision footprint box showing exact BlockBounds for overhanging visual models
    extrudeGroup.add(
      createCrispLineSegments(collisionPts, {
        color: isGhost ? ghostTint : isSelected ? palette.lineSelected : palette.connLarge,
        opacity: isGhost ? opacity * 0.88 : opacity * 0.58,
        widthPx: isGhost ? 1.15 : 0.95,
        lodTier: isGhost ? 'primary' : 'detail',
        dashed: true,
        dashSize: 0.65,
        gapSize: 0.48,
      })
    );
  }

  root.add(extrudeGroup);
  return { root, extrudeGroup, roofHeight };
}
