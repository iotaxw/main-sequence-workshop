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
  // Low flush mount vertical helper (exact 4.0m deck: top mounts sit flush on y=0, _B bottom mounts hug y=4.0 ceiling!)
  const vy = (y0: number, y1: number): [number, number] =>
    isBottomMount ? [Math.max(0.05, 4.0 - y1), Math.min(4.0, 4.0 - y0)] : [y0, y1];
  const outFaceY = (y0: number, y1: number, eps = 0.03): number =>
    isBottomMount ? Math.min(y0, y1) - eps : Math.max(y0, y1) + eps;

  const id = def.id;

  // =========================================================================
  // 1. COCKPITS & BRIDGES (real tapered short noses & wide cruiser bridge!)
  // =========================================================================
  if (id === 'BPO_Cockpit_01') {
    // Real mesh: X[-4.01..1.38], Y[-4..4], Z[-0.46..3.18] -> normalized y[0.35..4.0]
    roofHeight = 4.0;
    accentColor = palette.researchTint;
    const xRear = lx(-3.95);
    const xMid = lx(-0.85);
    const xNose = lx(1.38);
    const hullLoop: Array<[number, number]> = [
      [xRear, -3.85],
      [xMid, -3.4],
      [xNose, -1.75],
      [xNose, 1.75],
      [xMid, 3.4],
      [xRear, 3.85],
    ];
    addExtrudedLoop(extrudeGroup, hullLoop, 0.25, 2.35, fillBase, primaryPts, detailPts);
    const canopyLoop: Array<[number, number]> = [
      [lx(-3.2), -2.45],
      [lx(-0.9), -2.25],
      [lx(0.85), -1.35],
      [lx(0.85), 1.35],
      [lx(-0.9), 2.25],
      [lx(-3.2), 2.45],
    ];
    addExtrudedLoop(extrudeGroup, canopyLoop, 2.35, roofHeight, fillUpper, primaryPts, detailPts);
    // Panoramic forward glass mullions
    pushSeg(accentPts, lx(0.85), -1.35, xNose, -1.65, roofHeight, 2.35);
    pushSeg(accentPts, lx(0.85), 1.35, xNose, 1.65, roofHeight, 2.35);
    pushSeg(accentPts, lx(0.85), -1.35, lx(0.85), 1.35, roofHeight + 0.03);
    pushSeg(accentPts, lx(0.85), 0, xNose, 0, roofHeight, 2.35);
  } else if (id === 'BPO_Cockpit_02') {
    // Real mesh: 2x2x2, X[-8..4.27], Y[-8..8], Z[-0.84..6.06] -> normalized y[0..6.9]
    roofHeight = 6.9;
    accentColor = palette.researchTint;
    const hullLoop: Array<[number, number]> = [
      [lx(-7.95), -7.85],
      [lx(-1.2), -7.85],
      [lx(4.25), -3.8],
      [lx(4.25), 3.8],
      [lx(-1.2), 7.85],
      [lx(-7.95), 7.85],
    ];
    addExtrudedLoop(extrudeGroup, hullLoop, 0, 4.0, fillBase, primaryPts, detailPts, { verticalToPrimary: true });
    const crownLoop: Array<[number, number]> = [
      [lx(-6.8), -5.4],
      [lx(-1.4), -5.4],
      [lx(2.4), -2.8],
      [lx(2.4), 2.8],
      [lx(-1.4), 5.4],
      [lx(-6.8), 5.4],
    ];
    addExtrudedLoop(extrudeGroup, crownLoop, 4.0, roofHeight, fillUpper, primaryPts, detailPts);
    // Wraparound bridge glass canopy lines
    pushSeg(accentPts, lx(2.4), -2.8, lx(4.25), -3.7, roofHeight, 4.0);
    pushSeg(accentPts, lx(2.4), 2.8, lx(4.25), 3.7, roofHeight, 4.0);
    pushSeg(accentPts, lx(2.4), -2.8, lx(2.4), 2.8, roofHeight + 0.04);
    pushSeg(accentPts, lx(2.4), 0, lx(4.25), 0, roofHeight, 4.0);
  } else if (id === 'BPO_Cockpit_03') {
    // Real mesh: col 20x16x8 (X[-12..8], Y[-8..8]), visual WIDE winged cruiser bridge X[-12..11.98], Y[-11.8..11.8], Z[-0.84..5.3] -> y[0..6.15]
    roofHeight = 6.15;
    accentColor = palette.researchTint;
    const hullLoop: Array<[number, number]> = [
      [lx(-11.95), -11.5],
      [lx(0.5), -11.5],
      [lx(11.85), -5.2],
      [lx(11.85), 5.2],
      [lx(0.5), 11.5],
      [lx(-11.95), 11.5],
    ];
    addExtrudedLoop(extrudeGroup, hullLoop, 0, 3.85, fillBase, primaryPts, detailPts, { verticalToPrimary: true });
    const deckLoop: Array<[number, number]> = [
      [lx(-10.5), -7.6],
      [lx(0.2), -7.6],
      [lx(8.6), -3.8],
      [lx(8.6), 3.8],
      [lx(0.2), 7.6],
      [lx(-10.5), 7.6],
    ];
    addExtrudedLoop(extrudeGroup, deckLoop, 3.85, roofHeight, fillUpper, primaryPts, detailPts);
    // Swept panoramic bridge visor
    pushSeg(accentPts, lx(8.6), -3.8, lx(11.85), -5.1, roofHeight, 3.85);
    pushSeg(accentPts, lx(8.6), 3.8, lx(11.85), 5.1, roofHeight, 3.85);
    pushSeg(accentPts, lx(8.6), -3.8, lx(8.6), 3.8, roofHeight + 0.04);
    pushSeg(accentPts, lx(0.2), -7.6, lx(0.5), -11.5, roofHeight, 3.85);
    pushSeg(accentPts, lx(0.2), 7.6, lx(0.5), 11.5, roofHeight, 3.85);
    // Dashed collision footprint (exact 20x16m BlockBounds inside the wider 24x23.6m visual bridge)
    addCollisionFootprintHint(collisionPts, lx(-12), lx(8), lz(-8), lz(8));

  // =========================================================================
  // 2. HULLS, CORNERS, WINDOWS, OPEN CROSS-FRAMES & LADDER (exact 4.0m / 8.0m)
  // =========================================================================
  } else if (id === 'BPO_Body_01' || id === 'BPO_Body_02') {
    roofHeight = 4.0;
    addBox(extrudeGroup, 0, 0, hw - 0.06, hd - 0.06, 0, roofHeight, fillBase, primaryPts, detailPts, 0.45);
    // Real outer frame collar + recessed central rounded hatch panel
    pushLoop(detailPts, getChamferLoop(hw - 1.35, hd - 1.35, 0.65), roofHeight + 0.02);
    for (const s of [-1, 1]) {
      pushSeg(detailPts, s * (hw - 0.12), -1.8, s * (hw - 1.25), -1.8, roofHeight + 0.02);
      pushSeg(detailPts, s * (hw - 0.12), 1.8, s * (hw - 1.25), 1.8, roofHeight + 0.02);
    }
    if (id === 'BPO_Body_02') {
      // Recessed panoramic window strip along +Z face
      accentColor = palette.researchTint;
      pushSeg(accentPts, -3.05, hd - 0.08, 3.05, hd - 0.08, roofHeight - 0.45);
      pushSeg(accentPts, -3.05, hd - 0.08, 3.05, hd - 0.08, 0.75);
      for (const wx of [-3.05, -1.0, 1.0, 3.05]) {
        pushSeg(accentPts, wx, hd - 0.08, wx, hd - 0.08, 0.75, roofHeight - 0.45);
      }
    }
  } else if (id === 'BPO_ShipCorner_01') {
    // Real chamfered corner cabin with large panoramic diagonal glass along (+X,+Z)
    roofHeight = 4.0;
    accentColor = palette.researchTint;
    const loop: Array<[number, number]> = [
      [-hw + 0.06, -hd + 0.06],
      [hw - 0.06, -hd + 0.06],
      [hw - 0.06, -hd + 2.3],
      [-hw + 2.3, hd - 0.06],
      [-hw + 0.06, hd - 0.06],
    ];
    addExtrudedLoop(extrudeGroup, loop, 0, roofHeight, fillBase, primaryPts, detailPts);
    // Diagonal panoramic window mullions
    pushSeg(accentPts, hw - 0.14, -hd + 2.35, -hw + 2.35, hd - 0.14, roofHeight - 0.4);
    pushSeg(accentPts, hw - 0.14, -hd + 2.35, -hw + 2.35, hd - 0.14, 0.7);
    pushSeg(accentPts, 0.9, -0.9, 0.9, -0.9, 0.7, roofHeight - 0.4);
  } else if (id === 'BPO_WindowBlock') {
    // Real flush side-mounted protruding viewport bay hugging -X hull wall (-hw .. -hw + 1.7m)!
    roofHeight = 3.28;
    accentColor = palette.researchTint;
    const x0 = -hw;
    const x1 = -hw + 1.7;
    const loop: Array<[number, number]> = [
      [x0, -1.62],
      [x1 - 0.45, -1.62],
      [x1, -1.05],
      [x1, 1.05],
      [x1 - 0.45, 1.62],
      [x0, 1.62],
    ];
    addExtrudedLoop(extrudeGroup, loop, 0.72, roofHeight, fillUpper, primaryPts, detailPts);
    pushSeg(accentPts, x1, -1.05, x1, 1.05, 1.05);
    pushSeg(accentPts, x1, -1.05, x1, 1.05, roofHeight - 0.35);
    pushSeg(accentPts, x1, 0, x1, 0, 1.05, roofHeight - 0.35);
  } else if (id === 'BPO_Frame_01') {
    // Real open cross-shaped (+) structural girder corridor (all 4 corners cleanly open!)
    roofHeight = 4.0;
    const arm = 1.65;
    const e = hw - 0.06;
    const crossLoop: Array<[number, number]> = [
      [-arm, -e], [arm, -e], [arm, -arm],
      [e, -arm], [e, arm], [arm, arm],
      [arm, e], [-arm, e], [-arm, arm],
      [-e, arm], [-e, -arm], [-arm, -arm],
    ];
    addExtrudedLoop(extrudeGroup, crossLoop, 0, roofHeight, fillBase, primaryPts, detailPts);
    pushLoop(detailPts, getChamferLoop(1.25, 1.25, 0.35), roofHeight + 0.02);
    // Open truss diagonal cross-bracing along each arm
    for (const s of [-1, 1]) {
      pushSeg(detailPts, s * 1.65, -arm, s * e, arm, roofHeight + 0.02);
      pushSeg(detailPts, -arm, s * 1.65, arm, s * e, roofHeight + 0.02);
    }
  } else if (id === 'BPO_FrameSlope_01T' || id === 'BPO_FrameSlope_01B') {
    // Real cantilever open triangular truss: flush on -X (-4) and y=0 (T) or y=4.0 (B)!
    const isBot = id === 'BPO_FrameSlope_01B';
    roofHeight = isBot ? 4.0 : 3.28;
    const loop: Array<[number, number]> = [
      [lx(-4.0), -1.95],
      [lx(-2.2), -1.95],
      [lx(1.95), -1.35],
      [lx(1.95), 1.35],
      [lx(-2.2), 1.95],
      [lx(-4.0), 1.95],
    ];
    addExtrudedLoop(extrudeGroup, loop, isBot ? 2.4 : 0, isBot ? 4.0 : 1.6, fillBase, primaryPts, detailPts);
    // Sloping triangular cantilever girder struts
    const yRear = isBot ? 0.72 : 3.28;
    const yTip = isBot ? 3.25 : 0.75;
    for (const sz of [-1.2, 1.2]) {
      pushSeg(primaryPts, lx(-3.95), sz, lx(1.9), sz * 0.8, yRear, yTip);
      pushSeg(detailPts, lx(-3.95), sz, lx(-3.95), sz, isBot ? 0.72 : 0, isBot ? 4.0 : 3.28);
    }
    pushSeg(primaryPts, lx(-3.95), -1.2, lx(-3.95), 1.2, yRear, yRear);
    pushSeg(primaryPts, lx(1.9), -0.96, lx(1.9), 0.96, yTip, yTip);
  } else if (id === 'BPO_LadderBlock') {
    roofHeight = 8.0;
    addBox(extrudeGroup, 0, 0, hw - 0.06, hd - 0.06, 0, roofHeight, fillBase, primaryPts, detailPts, 0.45, true);
    pushLoop(primaryPts, getChamferLoop(1.45, 1.45, 0.35), roofHeight + 0.03);
    for (let ry = 1.2; ry < roofHeight; ry += 1.4) {
      pushSeg(detailPts, -0.95, -1.2, 0.95, -1.2, ry, ry);
    }

  // =========================================================================
  // 3. THRUSTERS (true elongated overhangs, verified PAK mount edges + dashed collision!)
  // =========================================================================
  } else if (id === 'BPO_Thruster_02R' || id === 'BPO_Thruster_02L') {
    // Verified PAK: 02R mounts flush on -Z (-4.0, attaching to hull Starboard +Z); 02L mounts on +Z (+4.0, hull Port -Z).
    const isLeft = id === 'BPO_Thruster_02L';
    const sz = isLeft ? 1 : -1; // Mount side: +Z for L, -Z for R
    roofHeight = 3.48;
    const xFront = lx(3.15);
    const xRearBody = lx(-7.2);
    const zMount = sz * 4.0;
    const zOuter = -sz * 1.84;
    const zMid = (zMount + zOuter) / 2;
    const podLoop: Array<[number, number]> = [
      [lx(1.8), zMount],
      [xFront, zMount - sz * 1.3],
      [xFront - 1.1, zOuter + sz * 0.4],
      [lx(-0.6), zOuter],
      [xRearBody, zOuter + sz * 0.35],
      [xRearBody, zMount - sz * 0.45],
      [lx(-4.0), zMount],
    ];
    addExtrudedLoop(extrudeGroup, podLoop, 0.54, roofHeight, fillBase, primaryPts, detailPts);
    // Twin stepped aft exhaust cones reaching X = -10.0m!
    addAftNozzle(extrudeGroup, xRearBody, lx(-10.0), zMid - sz * 0.95, 2.0, 0.95, 0.42, fillUpper, primaryPts, detailPts, 8);
    addAftNozzle(extrudeGroup, xRearBody + 0.9, lx(-8.95), zMid + sz * 0.85, 2.0, 0.88, 0.4, fillUpper, primaryPts, detailPts, 8);
    addCollisionFootprintHint(collisionPts, -hw, hw, -hd, hd);
  } else if (id === 'BPO_Thruster_04R' || id === 'BPO_Thruster_04L') {
    // Verified PAK: 04R mounts flush on -Z (-4.0, straight inner rail & long inner tail fin along zMount!), curved nacelle out to +3.75!
    const isLeft = id === 'BPO_Thruster_04L';
    const sz = isLeft ? 1 : -1; // +1 mounts at +Z (Port side of ship), -1 mounts at -Z (Starboard side of ship)
    roofHeight = 3.85;
    accentColor = palette.researchTint;
    const xFront = lx(3.38);
    const xCoreRear = lx(-8.4);
    const xInnerFinTip = lx(-14.55);
    const zMount = sz * 4.0; // Flush straight hull-side rail (edgesNear(-4)=273 for 04R, edgesNear(+4)=275 for 04L!)
    const zOuter = -sz * 3.72; // Curved outboard intake fairing
    const zCenter = sz * 0.15;
    // Authentic silhouette matching ship_sheet_2.png: straight hull-side mount & long inner spine on zMount, curved cowl on zOuter
    const bodyLoop: Array<[number, number]> = [
      [lx(1.8), zMount],
      [xFront, zMount - sz * 1.4],
      [xFront - 1.2, zOuter + sz * 1.2],
      [lx(-0.8), zOuter],
      [lx(-7.6), zOuter + sz * 0.9],
      [lx(-11.2), zOuter + sz * 1.6],
      [xCoreRear, zCenter - sz * 0.8],
      [xCoreRear, zCenter + sz * 0.9],
      [xInnerFinTip, zMount - sz * 0.55],
      [lx(-4.0), zMount],
    ];
    addExtrudedLoop(extrudeGroup, bodyLoop, 0.15, roofHeight, fillBase, primaryPts, detailPts);
    // Twin staggered relic aft exhaust cones + glowing cyan relic conduit ridges
    addAftNozzle(extrudeGroup, xCoreRear, lx(-13.6), zCenter - sz * 1.05, 2.0, 1.05, 0.42, fillUpper, primaryPts, detailPts, 6);
    addAftNozzle(extrudeGroup, xCoreRear + 0.8, lx(-11.8), zCenter + sz * 1.05, 2.0, 0.98, 0.4, fillUpper, primaryPts, detailPts, 6);
    pushSeg(accentPts, lx(1.2), zCenter, xCoreRear, zCenter, roofHeight + 0.04);
    pushSeg(accentPts, lx(-3.5), zMount - sz * 0.45, xInnerFinTip + 0.4, zMount - sz * 0.65, roofHeight + 0.04);
    pushSeg(accentPts, lx(-2.2), zOuter + sz * 0.8, lx(-10.8), zOuter + sz * 1.65, roofHeight + 0.04);
    addCollisionFootprintHint(collisionPts, -hw, hw, -hd, hd);
  } else if (id === 'BPO_Thruster_03') {
    // Real mesh: 2x1x2 (16x8x8m), X[-12..4], Y[-4..4] — armored double-deck housing + vertically stacked twin exhausts
    roofHeight = 8.0;
    const xFront = lx(3.98);
    const xBodyRear = lx(-7.2);
    const loop: Array<[number, number]> = [
      [xFront, -3.6],
      [xFront, 3.6],
      [lx(-1.5), 3.85],
      [xBodyRear, 3.3],
      [xBodyRear, -3.3],
      [lx(-1.5), -3.85],
    ];
    addExtrudedLoop(extrudeGroup, loop, 0, roofHeight, fillBase, primaryPts, detailPts, { verticalToPrimary: true });
    addAftNozzle(extrudeGroup, xBodyRear, lx(-12.0), 0, 2.2, 2.0, 0.95, fillUpper, primaryPts, detailPts, 10);
    addAftNozzle(extrudeGroup, xBodyRear, lx(-12.0), 0, 5.8, 2.0, 0.95, fillUpper, primaryPts, detailPts, 10);
    pushSeg(detailPts, lx(2.5), 0, xBodyRear, 0, roofHeight + 0.03);
  } else if (id === 'BPO_Thruster_05') {
    // Real mesh: 2x3x2 (16x24x8m), X[-12.76..4.04], Y[-11.79..11.79] — colossal wide capital engine with 3-bank twin-stack nozzles!
    roofHeight = 8.0;
    const xFront = lx(3.98);
    const xBodyRear = lx(-5.8);
    addBox(extrudeGroup, (xFront + xBodyRear) / 2, 0, (xFront - xBodyRear) / 2, hd - 0.25, 0, roofHeight, fillBase, primaryPts, detailPts, 1.35, true);
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
    roofHeight = 4.0;
    accentColor = palette.powerTint;
    const dLoop = makeDLoop(lx(3.98), lx(0.65), 3.82, 3.92, 12);
    addExtrudedLoop(extrudeGroup, dLoop, 0, 2.95, fillBase, primaryPts, detailPts, { skipVertStep: 2 });
    addDrum(extrudeGroup, lx(0.95), 0, 2.15, 1.75, 12, 2.95, roofHeight, 0, fillUpper, primaryPts, detailPts, 6);
    pushPolygon(accentPts, 1.72, 12, roofHeight + 0.04, 0, lx(0.95), 0);
    pushPolygon(accentPts, 0.75, 6, roofHeight + 0.05, 0, lx(0.95), 0);
    for (const ang of [Math.PI * 0.65, Math.PI, Math.PI * 1.35]) {
      pushSeg(
        accentPts,
        lx(0.95) + Math.cos(ang) * 1.85,
        Math.sin(ang) * 1.85,
        lx(0.65) + Math.cos(ang) * 3.7,
        Math.sin(ang) * 3.75,
        roofHeight - 0.25,
        2.95
      );
    }
  } else if (id === 'BPO_WarpDriveBlock') {
    roofHeight = 4.0;
    accentColor = palette.researchTint;
    const ringCx = lx(0.15);
    const dLoop = makeDLoop(lx(3.98), ringCx, 3.88, 3.92, 14);
    addExtrudedLoop(extrudeGroup, dLoop, 0, 2.55, fillBase, primaryPts, detailPts, {
      skipVertStep: 2,
      holeRadius: 1.65,
      holeCx: ringCx,
      holeCz: 0,
    });
    const outerLoop: Array<[number, number]> = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      outerLoop.push([ringCx + Math.cos(a) * 3.35, Math.sin(a) * 3.35]);
    }
    addExtrudedLoop(extrudeGroup, outerLoop, 2.55, roofHeight, fillUpper, primaryPts, detailPts, {
      skipVertStep: 2,
      holeRadius: 1.72,
      holeCx: ringCx,
      holeCz: 0,
    });
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
    roofHeight = 7.45;
    accentColor = palette.researchTint;
    addBox(extrudeGroup, 0, 0, hw - 0.15, hd - 0.15, 0, 4.0, fillBase, primaryPts, detailPts, 1.1, true);
    const ringLoop: Array<[number, number]> = [];
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      ringLoop.push([Math.cos(a) * 5.8, Math.sin(a) * 5.8]);
    }
    addExtrudedLoop(extrudeGroup, ringLoop, 4.0, 6.2, fillUpper, primaryPts, detailPts, {
      skipVertStep: 3,
      holeRadius: 3.1,
    });
    pushPolygon(accentPts, 5.8, 18, 6.25);
    pushPolygon(accentPts, 3.1, 18, 6.25);
    for (const sz of [-1, 1]) {
      addBox(extrudeGroup, 0, sz * 8.6, 5.2, 1.85, 4.0, 5.65, fillUpper, primaryPts, detailPts, 0.4);
      pushSeg(accentPts, -4.6, sz * 8.6, 4.6, sz * 8.6, 5.7);
    }
    pushArc(accentPts, 0, 0, 4.4, 0, Math.PI * 2, 16, roofHeight);

  // =========================================================================
  // 5. LOW FLUSH ROOF/BELLY ATTACHMENTS (Exact flush docking at y=0 top / y=4.0 bottom!)
  // =========================================================================
  } else if (id.startsWith('BPO_CannonBlock')) {
    // Real mesh: Z[-0.85..0.65] (1.50m tall), flush base on deck y=0 (top) or ceiling y=4.0 (_B) + twin barrels to +4.64m!
    const [b0, b1] = vy(0, 0.72);
    const [t0, t1] = vy(0.72, 1.5);
    const outY = outFaceY(t0, t1);
    roofHeight = Math.max(b1, t1);
    accentColor = palette.turretTint;
    addBox(extrudeGroup, lx(-0.8), 0, 2.0, 2.22, b0, b1, fillBase, primaryPts, detailPts, 0.55);
    addBox(extrudeGroup, lx(-0.65), 0, 1.65, 1.55, t0, t1, fillUpper, primaryPts, detailPts, 0.4);
    const by0 = (t0 + t1) * 0.5 - 0.24;
    const by1 = (t0 + t1) * 0.5 + 0.24;
    const barrelAccentY = outFaceY(by0, by1);
    for (const bz of [-1.08, 1.08]) {
      addBox(extrudeGroup, lx(2.55), bz, 2.1, 0.36, by0, by1, fillUpper, primaryPts, detailPts, 0.08);
      pushSeg(accentPts, lx(0.6), bz, lx(4.64), bz, barrelAccentY);
    }
    pushSeg(accentPts, lx(-1.8), -0.9, lx(-1.8), 0.9, outY);
  } else if (id.startsWith('BPO_MiningLaserBlock')) {
    // Real mesh: Z[-0.85..1.88] (2.73m tall), flush base on deck y=0 (top) or ceiling y=4.0 (_B) + single barrel to +4.45m!
    const [b0, b1] = vy(0, 0.95);
    const [t0, t1] = vy(0.95, 2.55);
    const outY = outFaceY(t0, t1);
    roofHeight = Math.max(b1, t1);
    accentColor = palette.powerTint;
    addBox(extrudeGroup, lx(-0.45), 0, 2.05, 2.2, b0, b1, fillBase, primaryPts, detailPts, 0.45);
    const bore0 = isBottomMount ? t0 + 0.18 : (b0 + b1) * 0.5;
    const bore1 = isBottomMount ? (b0 + b1) * 0.5 : t1 - 0.18;
    addBox(extrudeGroup, lx(1.95), 0, 2.5, 0.78, Math.min(bore0, bore1), Math.max(bore0, bore1), fillUpper, primaryPts, detailPts, 0.25);
    for (const fx of [-1.6, -0.7, 0.2]) {
      pushSeg(accentPts, lx(fx), -1.35, lx(fx), 1.35, outY);
    }
    pushSeg(accentPts, lx(0.8), 0, lx(4.45), 0, outFaceY(bore0, bore1));
  } else if (id.startsWith('BPO_TractorBeamBlock')) {
    // Real mesh: Z[-0.85..0.73] (1.58m tall), flush base on y=0 (top) or y=4.0 (_B) + circular emitter!
    const [b0, b1] = vy(0, 0.82);
    const [t0, t1] = vy(0.82, 1.58);
    const outY = outFaceY(t0, t1, 0.04);
    roofHeight = Math.max(b1, t1);
    accentColor = palette.solarTint;
    addBox(extrudeGroup, lx(0.45), 0, 2.68, 2.22, b0, b1, fillBase, primaryPts, detailPts, 0.6);
    addDrum(extrudeGroup, lx(0.35), 0, 1.55, 1.35, 12, t0, t1, 0, fillUpper, primaryPts, detailPts, 4);
    pushPolygon(accentPts, 1.15, 12, outY, 0, lx(0.35), 0);
    pushPolygon(accentPts, 0.55, 8, outFaceY(t0, t1, 0.05), 0, lx(0.35), 0);
  } else if (id.startsWith('BPO_ShipLaserTurretBlock')) {
    // Real mesh: Z[-0.85..0.65] (1.50m tall), flush 6-petal radial star PD turret!
    const [b0, b1] = vy(0, 0.68);
    const [t0, t1] = vy(0.68, 1.5);
    const outY = outFaceY(t0, t1);
    roofHeight = Math.max(b1, t1);
    accentColor = palette.turretTint;
    addDrum(extrudeGroup, 0, 0, 2.25, 1.95, 12, b0, b1, 0, fillBase, primaryPts, detailPts, 6);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      const px = Math.cos(a) * 2.15;
      const pz = Math.sin(a) * 1.9;
      addDrum(extrudeGroup, px, pz, 0.65, 0.52, 6, t0, t1, a, fillUpper, primaryPts, detailPts, 2);
      pushSeg(accentPts, Math.cos(a) * 1.1, Math.sin(a) * 1.0, Math.cos(a) * 2.85, Math.sin(a) * 2.45, outY);
    }
    pushPolygon(accentPts, 1.05, 6, outY);
  } else if (id.startsWith('BPO_ShipShieldGenerator_01')) {
    // Real mesh: Z[-0.85..1.07] (1.92m tall), flush flat X-braced twin-truss emitter frame!
    const [b0, b1] = vy(0, 0.92);
    const [t0, t1] = vy(0.92, 1.92);
    const outY = outFaceY(t0, t1, 0.04);
    roofHeight = Math.max(b1, t1);
    accentColor = palette.solarTint;
    addBox(extrudeGroup, 0, 0, 3.78, 2.22, b0, b1, fillBase, primaryPts, detailPts, 0.65);
    for (const sz of [-1.45, 1.45]) {
      addBox(extrudeGroup, 0, sz, 3.25, 0.45, t0, t1, fillUpper, primaryPts, detailPts, 0.15);
    }
    pushSeg(accentPts, -3.1, -1.45, 3.1, 1.45, outY);
    pushSeg(accentPts, -3.1, 1.45, 3.1, -1.45, outY);
    pushSeg(accentPts, -3.4, 0, 3.4, 0, outFaceY(t0, t1, 0.03));
    for (const fx of [-2.1, 0, 2.1]) {
      pushSeg(accentPts, fx, -1.75, fx, 1.75, outFaceY(t0, t1, 0.03));
    }
  } else if (id === 'BPO_LanceBlock') {
    // Real mesh: 32m (4x1) SLEEK NARROW SPINAL RAILGUN (Z[-0.8..3.1] -> y[0.05..3.95])
    roofHeight = 3.95;
    accentColor = palette.turretTint;
    addBox(extrudeGroup, lx(-12.0), 0, 3.5, 2.55, 0.05, roofHeight, fillBase, primaryPts, detailPts, 0.55);
    addBox(extrudeGroup, lx(-5.0), 0, 3.6, 1.65, 0.35, 3.35, fillBase, primaryPts, detailPts, 0.35);
    addBox(extrudeGroup, lx(7.2), 0, 8.7, 0.92, 0.75, 2.85, fillUpper, primaryPts, detailPts, 0.2);
    for (let rx = -1.0; rx <= 14.5; rx += 3.0) {
      pushSeg(accentPts, lx(rx), -1.15, lx(rx), 1.15, 2.9);
    }
    pushSeg(accentPts, lx(-8.0), 0, lx(15.9), 0, 2.92);
  } else if (id === 'BPO_MissileLauncherBlock_01') {
    // Real mesh: 1x1x2 (8x8x8m) heavy vertical block with recessed 2x2 quad missile silos
    roofHeight = 8.0;
    accentColor = palette.turretTint;
    addBox(extrudeGroup, 0, 0, hw - 0.08, hd - 0.08, 0, roofHeight, fillBase, primaryPts, detailPts, 0.5, true);
    pushLoop(detailPts, getChamferLoop(2.65, 2.65, 0.35), roofHeight + 0.02);
    for (const sx of [-1.2, 1.2]) {
      for (const sz of [-1.2, 1.2]) {
        pushPolygon(primaryPts, 0.85, 10, roofHeight + 0.04, 0, sx, sz);
        pushPolygon(accentPts, 0.42, 8, roofHeight + 0.05, 0, sx, sz);
      }
    }

  // =========================================================================
  // 6. ARMOUR WINGS & TRUE SLOPED ARMOUR WEDGES (verified PAK mounting edges!)
  // =========================================================================
  } else if (id === 'BPO_Armour_01R' || id === 'BPO_Armour_01L') {
    // Verified PAK: 01R mounts flush on +Z (+4.0, edgesNear(+4)=51, 4m wide [0..+4]); 01L mounts on -Z (-4.0, [-4..0])!
    const isLeft = id === 'BPO_Armour_01L';
    const sz = isLeft ? -1 : 1; // +1 mounts at +Z (01R), -1 mounts at -Z (01L)
    roofHeight = 3.47;
    const zBase = sz * hd; // Flush with outer cell boundary (+4 for R, -4 for L)
    const zTip = sz * 0.1; // Half-cell (4m) true aerodynamic wing width matching PAK MeshY!
    const wingLoop: Array<[number, number]> = [
      [-hw + 0.08, zBase],
      [hw - 0.08, zBase],
      [hw - 1.2, zBase - sz * 1.1],
      [hw - 4.8, zTip],
      [-hw + 3.2, zTip],
      [-hw + 0.9, zBase - sz * 1.4],
    ];
    addExtrudedLoop(extrudeGroup, wingLoop, 0.54, roofHeight, fillBase, primaryPts, detailPts);
    pushSeg(detailPts, -hw + 3.5, (zBase + zTip) * 0.5, hw - 4.2, (zBase + zTip) * 0.5, roofHeight + 0.02);
  } else if (id.startsWith('BPO_ArmourSlope_')) {
    // Real mesh: true wedge-shaped sloped armour plate spanning exact 4.0m deck height!
    const isBot = id.endsWith('B');
    roofHeight = 4.0;
    if (!isBot) {
      addSlopedWedge(
        extrudeGroup,
        -hw + 0.06,
        hw - 0.06,
        -hd + 0.06,
        hd - 0.06,
        0,
        4.0,
        0.75,
        fillBase,
        primaryPts,
        detailPts
      );
      pushSeg(detailPts, 0, -hd + 0.25, 0, hd - 0.25, 2.38);
    } else {
      // Inverted underside wedge: flat top flush at y=4.0, sloping underside from y=0.05 (-X) to y=3.25 (+X)
      const x0 = -hw + 0.06;
      const x1 = hw - 0.06;
      const z0 = -hd + 0.06;
      const z1 = hd - 0.06;
      const shape = new THREE.Shape();
      shape.moveTo(x0, 4.0);
      shape.lineTo(x1, 4.0);
      shape.lineTo(x1, 3.25);
      shape.lineTo(x0, 0.05);
      shape.closePath();
      const geo = new THREE.ExtrudeGeometry(shape, { depth: z1 - z0, bevelEnabled: false, curveSegments: 1 });
      geo.translate(0, 0, z0);
      extrudeGroup.add(new THREE.Mesh(geo, fillBase));
      pushLoop(primaryPts, [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], 4.01);
      pushSeg(primaryPts, x0, z0, x1, z0, 0.05, 3.25);
      pushSeg(primaryPts, x0, z1, x1, z1, 0.05, 3.25);
      pushSeg(detailPts, x0, z0, x0, z1, 0.05, 0.05);
      pushSeg(detailPts, x1, z0, x1, z1, 3.25, 3.25);
      pushSeg(detailPts, x0, z0, x0, z0, 0.05, 4.0);
      pushSeg(detailPts, x0, z1, x0, z1, 0.05, 4.0);
      pushSeg(detailPts, x1, z0, x1, z0, 3.25, 4.0);
      pushSeg(detailPts, x1, z1, x1, z1, 3.25, 4.0);
      pushSeg(detailPts, 0, -hd + 0.25, 0, hd - 0.25, 4.02);
    }

  // =========================================================================
  // 7. UTILITY MODULES (Docking Collar, Workstation, Container, Gear, Hangar, Scanners)
  // =========================================================================
  } else if (id === 'BPO_DockingCollar') {
    // Real mesh: half-depth 8x4m flush against -Z cell edge (z[-4.0..0.0]) so it docks flush to hull!
    roofHeight = 4.0;
    const loop: Array<[number, number]> = [
      [-hw + 0.08, -hd],
      [hw - 0.08, -hd],
      [hw - 1.1, -0.15],
      [-hw + 1.1, -0.15],
    ];
    addExtrudedLoop(extrudeGroup, loop, 0.2, roofHeight, fillBase, primaryPts, detailPts);
    pushLoop(primaryPts, getChamferLoop(1.65, 0.95, 0.45, 0, -2.05), roofHeight + 0.03);
    pushSeg(detailPts, -1.2, -2.05, 1.2, -2.05, roofHeight + 0.04);
  } else if (id === 'BPO_WorkstationBlock') {
    // Real mesh: half-depth 8x4m flush against +Z cell edge (z[0.15..+4.0])!
    roofHeight = 4.0;
    const loop: Array<[number, number]> = [
      [-hw + 0.08, hd],
      [hw - 0.08, hd],
      [hw - 1.1, 0.15],
      [-hw + 1.1, 0.15],
    ];
    addExtrudedLoop(extrudeGroup, loop, 0.2, roofHeight, fillBase, primaryPts, detailPts);
    pushPolygon(primaryPts, 1.0, 8, roofHeight + 0.03, 0, 0, 2.1);
  } else if (id === 'BPO_ShipContainerBlock') {
    roofHeight = 4.0;
    for (const sz of [-2.65, 2.65]) {
      addBox(extrudeGroup, 0, sz, hw - 0.1, 1.25, 0, roofHeight, fillBase, primaryPts, detailPts, 0.2);
      for (let rx = -2.8; rx <= 2.8; rx += 1.4) {
        pushSeg(detailPts, rx, sz - 1.2, rx, sz + 1.2, roofHeight + 0.02);
      }
    }
    addBox(extrudeGroup, 0, 0, hw - 0.15, 1.35, 0, 0.55, fillUpper, primaryPts, detailPts, 0.1);
  } else if (id === 'BPO_LandingGear_01') {
    // Real mesh: Z[1.01..3.16] -> normalized y[1.86..4.0] flush against upper deck ceiling!
    roofHeight = 4.0;
    addBox(extrudeGroup, 0, 0, hw - 0.15, 1.15, 2.75, roofHeight, fillBase, primaryPts, detailPts, 0.25);
    for (const sz of [-2.45, 2.45]) {
      addBox(extrudeGroup, 0, sz, 1.65, 1.15, 1.85, roofHeight - 0.1, fillUpper, primaryPts, detailPts, 0.25);
    }
  } else if (id === 'BPO_Hangar_2') {
    roofHeight = 8.0;
    addBox(extrudeGroup, 0, 0, hw - 0.12, hd - 0.12, 0, roofHeight, fillBase, primaryPts, detailPts, 0.75, true);
    pushLoop(primaryPts, getChamferLoop(hw - 2.6, hd - 2.6, 0.5), roofHeight + 0.03);
    for (const sz of [-5.2, 5.2]) {
      pushLoop(detailPts, getChamferLoop(3.6, 1.15, 0.35, 0, sz), roofHeight + 0.04);
    }
  } else if (id === 'BPO_AstronomicScanner' || id === 'BPO_BiosampleCollector') {
    // Real mesh: 2x3x2 (16x24x8m) spanning 2 full decks y[0..8.0] (upper hull bay y[4..8] + lower belly protrusion y[0..4])!
    const isBio = id === 'BPO_BiosampleCollector';
    roofHeight = 8.0;
    accentColor = isBio ? palette.powerTint : palette.researchTint;
    addBox(extrudeGroup, lx(0.1), 0, 7.85, 11.8, 0.35, roofHeight, fillBase, primaryPts, detailPts, 0.85, true);
    if (!isBio) {
      pushArc(accentPts, lx(7.4), 0, 6.2, Math.PI * 0.58, Math.PI * 1.42, 12, roofHeight + 0.04);
      pushSeg(accentPts, lx(1.2), 0, lx(8.75), 0, roofHeight + 0.04);
      pushPolygon(accentPts, 2.1, 10, roofHeight + 0.04, 0, lx(4.6), 0);
      pushArc(accentPts, lx(7.4), 0, 5.4, Math.PI * 0.58, Math.PI * 1.42, 12, 0.32);
    } else {
      for (let tz = -8.4; tz <= 8.4; tz += 2.8) {
        addBox(extrudeGroup, lx(5.8), tz, 2.95, 0.55, 1.2, 5.6, fillUpper, primaryPts, detailPts, 0.12);
        pushSeg(accentPts, lx(3.2), tz, lx(8.75), tz, 5.64);
        pushSeg(accentPts, lx(3.2), tz, lx(8.75), tz, 1.16);
      }
    }
    addCollisionFootprintHint(collisionPts, lx(-8), lx(8), lz(-12), lz(12));
  } else {
    roofHeight = 4.0;
    addBox(extrudeGroup, 0, 0, hw - 0.12, hd - 0.12, 0, roofHeight, fillBase, primaryPts, detailPts, 0.5);
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
