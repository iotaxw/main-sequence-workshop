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

/**
 * Build a clean closed watertight 3D lofted solid from ordered 2D (y, z) cross-section rings along X.
 * Each ring must have the same vertex count in consistent winding order.
 */
function addLoftedSolidX(
  target: THREE.Group,
  rings: Array<{ x: number; pts: Array<[number, number]> }>,
  fillMat: THREE.Material
): void {
  if (rings.length < 2) return;
  const n = rings[0].pts.length;
  if (n < 3) return;
  const pos: number[] = [];
  const pushTri = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number
  ) => {
    pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  };

  // Side quads between adjacent rings
  for (let r = 0; r < rings.length - 1; r++) {
    const a = rings[r];
    const b = rings[r + 1];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const [ay0, az0] = a.pts[i];
      const [ay1, az1] = a.pts[j];
      const [by0, bz0] = b.pts[i];
      const [by1, bz1] = b.pts[j];
      pushTri(a.x, ay0, az0, b.x, by0, bz0, b.x, by1, bz1);
      pushTri(a.x, ay0, az0, b.x, by1, bz1, a.x, ay1, az1);
    }
  }

  // End caps (fan from centroid)
  const capRing = (ring: { x: number; pts: Array<[number, number]> }, reverse: boolean) => {
    let cy = 0;
    let cz = 0;
    for (const [py, pz] of ring.pts) {
      cy += py;
      cz += pz;
    }
    cy /= n;
    cz /= n;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const [y0, z0] = ring.pts[i];
      const [y1, z1] = ring.pts[j];
      if (reverse) pushTri(ring.x, cy, cz, ring.x, y1, z1, ring.x, y0, z0);
      else pushTri(ring.x, cy, cz, ring.x, y0, z0, ring.x, y1, z1);
    }
  };
  capRing(rings[0], true);
  capRing(rings[rings.length - 1], false);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  const mat = fillMat.clone();
  mat.side = THREE.DoubleSide;
  target.add(new THREE.Mesh(geo, mat));
}

/** Add a slim structural girder beam between two 3D points with aligned outer CAD silhouette edges */
function addTrussStrut(
  target: THREE.Group,
  x1: number, y1: number, z1: number,
  x2: number, y2: number, z2: number,
  thickness: number,
  fillMat: THREE.Material,
  edgePts: number[]
): void {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dz = z2 - z1;
  const len = Math.hypot(dx, dy, dz);
  if (len <= 0.02) return;
  const geo = new THREE.BoxGeometry(thickness, len, thickness);
  const mesh = new THREE.Mesh(geo, fillMat);
  mesh.position.set((x1 + x2) * 0.5, (y1 + y2) * 0.5, (z1 + z2) * 0.5);
  const dir = new THREE.Vector3(dx / len, dy / len, dz / len);
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  mesh.quaternion.copy(quat);
  target.add(mesh);

  // Draw the 4 exact outer longitudinal corners of the box beam so front edges are never occluded by the fill!
  const r = thickness * 0.506;
  const u = new THREE.Vector3(1, 0, 0).applyQuaternion(quat).multiplyScalar(r);
  const v = new THREE.Vector3(0, 0, 1).applyQuaternion(quat).multiplyScalar(r);
  for (const su of [-1, 1]) {
    for (const sv of [-1, 1]) {
      const ox = u.x * su + v.x * sv;
      const oy = u.y * su + v.y * sv;
      const oz = u.z * su + v.z * sv;
      pushSeg(edgePts, x1 + ox, z1 + oz, x2 + ox, z2 + oz, y1 + oy, y2 + oy);
    }
  }
}

/** Add an open rectangular bulkhead frame ring on a constant-X or constant-Z plane */
function addOpenCollarFrame(
  target: THREE.Group,
  axis: 'x' | 'z',
  pos: number,
  halfSpan: number,
  y0: number,
  y1: number,
  bar: number,
  fillMat: THREE.Material,
  primaryPts: number[],
  detailPts: number[]
): void {
  const inner = Math.max(0.2, halfSpan - bar);
  const iy0 = y0 + bar;
  const iy1 = y1 - bar;
  if (axis === 'x') {
    // 4 bars on YZ plane at X=pos
    addTrussStrut(target, pos, y0 + bar * 0.5, -halfSpan, pos, y0 + bar * 0.5, halfSpan, bar, fillMat, primaryPts);
    addTrussStrut(target, pos, y1 - bar * 0.5, -halfSpan, pos, y1 - bar * 0.5, halfSpan, bar, fillMat, primaryPts);
    addTrussStrut(target, pos, y0, -halfSpan + bar * 0.5, pos, y1, -halfSpan + bar * 0.5, bar, fillMat, primaryPts);
    addTrussStrut(target, pos, y0, halfSpan - bar * 0.5, pos, y1, halfSpan - bar * 0.5, bar, fillMat, primaryPts);
    pushSeg(detailPts, pos, -inner, pos, inner, iy0, iy0);
    pushSeg(detailPts, pos, -inner, pos, inner, iy1, iy1);
    pushSeg(detailPts, pos, -inner, pos, -inner, iy0, iy1);
    pushSeg(detailPts, pos, inner, pos, inner, iy0, iy1);
  } else {
    addTrussStrut(target, -halfSpan, y0 + bar * 0.5, pos, halfSpan, y0 + bar * 0.5, pos, bar, fillMat, primaryPts);
    addTrussStrut(target, -halfSpan, y1 - bar * 0.5, pos, halfSpan, y1 - bar * 0.5, pos, bar, fillMat, primaryPts);
    addTrussStrut(target, -halfSpan + bar * 0.5, y0, pos, -halfSpan + bar * 0.5, y1, pos, bar, fillMat, primaryPts);
    addTrussStrut(target, halfSpan - bar * 0.5, y0, pos, halfSpan - bar * 0.5, y1, pos, bar, fillMat, primaryPts);
    pushSeg(detailPts, -inner, pos, inner, pos, iy0, iy0);
    pushSeg(detailPts, -inner, pos, inner, pos, iy1, iy1);
    pushSeg(detailPts, -inner, pos, -inner, pos, iy0, iy1);
    pushSeg(detailPts, inner, pos, inner, pos, iy0, iy1);
  }
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
    // Authentic PAK open 3D octagonal space-truss hub: 6-way open connector collars + tapered diagonal girder struts!
    roofHeight = 4.0;
    const hub = 1.72;
    const end = hw - 0.14;
    const bar = 0.22;
    const yMid0 = 0.92;
    const yMid1 = 3.08;

    // Top & bottom horizontal square connector rings (flush at y=0 and y=4.0 with open center!)
    for (const ry of [0.12, 3.88]) {
      addTrussStrut(extrudeGroup, -hub, ry, -hub, hub, ry, -hub, bar, fillBase, primaryPts);
      addTrussStrut(extrudeGroup, hub, ry, -hub, hub, ry, hub, bar, fillBase, primaryPts);
      addTrussStrut(extrudeGroup, hub, ry, hub, -hub, ry, hub, bar, fillBase, primaryPts);
      addTrussStrut(extrudeGroup, -hub, ry, hub, -hub, ry, -hub, bar, fillBase, primaryPts);
    }
    // 4 central vertical stanchions connecting top & bottom rings
    for (const sx of [-hub, hub]) {
      for (const sz of [-hub, hub]) {
        addTrussStrut(extrudeGroup, sx, 0.12, sz, sx, 3.88, sz, bar * 0.9, fillUpper, detailPts);
      }
    }
    // 4-way outboard open square connector collars at ±X and ±Z
    addOpenCollarFrame(extrudeGroup, 'x', end, 1.56, yMid0, yMid1, bar, fillBase, primaryPts, detailPts);
    addOpenCollarFrame(extrudeGroup, 'x', -end, 1.56, yMid0, yMid1, bar, fillBase, primaryPts, detailPts);
    addOpenCollarFrame(extrudeGroup, 'z', end, 1.56, yMid0, yMid1, bar, fillBase, primaryPts, detailPts);
    addOpenCollarFrame(extrudeGroup, 'z', -end, 1.56, yMid0, yMid1, bar, fillBase, primaryPts, detailPts);

    // 16 tapered upper/lower truss arms linking central hub corners to the 4 outboard collars
    for (const dir of [-1, 1]) {
      for (const side of [-1, 1]) {
        // ±X arms
        addTrussStrut(extrudeGroup, dir * hub, 3.86, side * hub, dir * end, yMid1 - 0.11, side * 1.48, bar * 0.85, fillUpper, primaryPts);
        addTrussStrut(extrudeGroup, dir * hub, 0.14, side * hub, dir * end, yMid0 + 0.11, side * 1.48, bar * 0.85, fillUpper, primaryPts);
        // ±Z arms
        addTrussStrut(extrudeGroup, side * hub, 3.86, dir * hub, side * 1.48, yMid1 - 0.11, dir * end, bar * 0.85, fillUpper, primaryPts);
        addTrussStrut(extrudeGroup, side * hub, 0.14, dir * hub, side * 1.48, yMid0 + 0.11, dir * end, bar * 0.85, fillUpper, primaryPts);
      }
    }
    // 8 diagonal corner brace struts tying adjacent arms into the iconic octagonal truss silhouette
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        addTrussStrut(extrudeGroup, sx * 2.85, yMid1 - 0.08, sz * 1.54, sx * 1.54, yMid1 - 0.08, sz * 2.85, bar * 0.72, fillUpper, detailPts);
        addTrussStrut(extrudeGroup, sx * 2.85, yMid0 + 0.08, sz * 1.54, sx * 1.54, yMid0 + 0.08, sz * 2.85, bar * 0.72, fillUpper, detailPts);
      }
    }
  } else if (id === 'BPO_FrameSlope_01T' || id === 'BPO_FrameSlope_01B') {
    // Authentic PAK open cantilever A-frame bracket: rear -X collar frame + 4 parallel struts + triangular foot bracket!
    const isBot = id === 'BPO_FrameSlope_01B';
    roofHeight = isBot ? 4.0 : 3.28;
    const bar = 0.2;
    const xCollar = lx(-3.86);
    const yCol0 = 0.92;
    const yCol1 = 3.08;
    const zSpan = 1.62;

    // 1. Rear (-X) open rectangular connector collar frame
    addOpenCollarFrame(extrudeGroup, 'x', xCollar, zSpan, yCol0, yCol1, bar, fillBase, primaryPts, detailPts);

    // 2. Forward triangular A-frame mounting bracket (flush on y=0 for 01T, flush on y=4.0 for 01B!)
    const yFoot = isBot ? 3.88 : 0.12;
    const yApex = isBot ? 1.38 : 2.62;
    const xFootBack = lx(-1.45);
    const xFootFront = lx(1.92);
    const xApex = lx(0.55);

    // Horizontal rectangular mounting base plate rails
    addTrussStrut(extrudeGroup, xFootBack, yFoot, -zSpan, xFootFront, yFoot, -zSpan, bar, fillBase, primaryPts);
    addTrussStrut(extrudeGroup, xFootBack, yFoot, zSpan, xFootFront, yFoot, zSpan, bar, fillBase, primaryPts);
    addTrussStrut(extrudeGroup, xFootBack, yFoot, -zSpan, xFootBack, yFoot, zSpan, bar, fillBase, primaryPts);
    addTrussStrut(extrudeGroup, xFootFront, yFoot, -zSpan, xFootFront, yFoot, zSpan, bar, fillBase, primaryPts);

    // Twin side A-frame triangular brackets + solid side gusset plates + cross axle at apex
    for (const sz of [-zSpan, zSpan]) {
      addTrussStrut(extrudeGroup, xFootBack, yFoot, sz, xApex, yApex, sz, bar * 0.95, fillUpper, primaryPts);
      addTrussStrut(extrudeGroup, xFootFront, yFoot, sz, xApex, yApex, sz, bar * 0.95, fillUpper, primaryPts);
      // Thin triangular gusset fill plate on each A-frame cheek matching PAK SIDE view
      const triGeo = new THREE.BufferGeometry();
      triGeo.setAttribute(
        'position',
        new THREE.Float32BufferAttribute([xFootBack, yFoot, sz, xFootFront, yFoot, sz, xApex, yApex, sz], 3)
      );
      triGeo.computeVertexNormals();
      const plateMat = fillBase.clone();
      plateMat.side = THREE.DoubleSide;
      extrudeGroup.add(new THREE.Mesh(triGeo, plateMat));
    }
    addTrussStrut(extrudeGroup, xApex, yApex, -zSpan, xApex, yApex, zSpan, bar * 0.95, fillUpper, primaryPts);

    // 3. Four parallel cantilever tie-rods from rear collar corners to A-frame apex & base
    for (const sz of [-zSpan + 0.08, zSpan - 0.08]) {
      if (!isBot) {
        addTrussStrut(extrudeGroup, xCollar, yCol1 - 0.1, sz, xApex, yApex, sz, bar * 0.8, fillUpper, primaryPts);
        addTrussStrut(extrudeGroup, xCollar, yCol0 + 0.1, sz, xFootBack + 0.15, yFoot + 0.16, sz, bar * 0.8, fillUpper, primaryPts);
      } else {
        addTrussStrut(extrudeGroup, xCollar, yCol0 + 0.1, sz, xApex, yApex, sz, bar * 0.8, fillUpper, primaryPts);
        addTrussStrut(extrudeGroup, xCollar, yCol1 - 0.1, sz, xFootBack + 0.15, yFoot - 0.16, sz, bar * 0.8, fillUpper, primaryPts);
      }
      pushSeg(detailPts, xCollar, sz, xApex, sz, (yCol0 + yCol1) * 0.5, yApex);
    }
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
  // 6. ARMOUR WINGS & BEVELED STREAMLINED ARMOUR SLOPES (1:1 PAK 4-view!)
  // =========================================================================
  } else if (id === 'BPO_Armour_01R' || id === 'BPO_Armour_01L') {
    // Authentic PAK 16x4m aerodynamic side armour wing: thick on hull-side zMount, tapered knife-edge outboard + notched aft vent!
    const isLeft = id === 'BPO_Armour_01L';
    const sz = isLeft ? -1 : 1; // +1 mounts flush at +Z (01R), -1 mounts flush at -Z (01L)
    roofHeight = 3.45;
    const zBase = sz * hd; // Flush with hull wall (+4 for R, -4 for L)
    const zOut = sz * 0.12; // Full outboard edge (4m wide)
    const zNotch = sz * 0.95; // Recessed aft panel notch
    const zNose = sz * 3.15; // Tapered bow edge near +X=8
    const zTail = sz * 2.45; // Tapered stern edge near -X=-8
    const yIn0 = 0.56;
    const yIn1 = 3.44;
    const yOut0 = 1.32;
    const yOut1 = 2.68;

    // Lofted 3D tapered aerodynamic prism along X from stern (-8) to bow (+8)
    const makeWingRing = (zEdge: number, yE0: number, yE1: number): Array<[number, number]> =>
      sz > 0
        ? [
            [yIn0, zBase],
            [yE0, zEdge],
            [yE1, zEdge],
            [yIn1, zBase],
          ]
        : [
            [yIn0, zBase],
            [yIn1, zBase],
            [yE1, zEdge],
            [yE0, zEdge],
          ];
    const wingSections: Array<{ x: number; zEdge: number; yE0: number; yE1: number }> = [
      { x: -hw + 0.08, zEdge: zTail, yE0: 1.05, yE1: 2.95 },
      { x: -hw + 1.4, zEdge: zOut, yE0: yOut0, yE1: yOut1 },
      { x: -hw + 5.6, zEdge: zOut, yE0: yOut0, yE1: yOut1 },
      { x: -hw + 6.2, zEdge: zNotch, yE0: 1.18, yE1: 2.82 },
      { x: -hw + 9.4, zEdge: zNotch, yE0: 1.18, yE1: 2.82 },
      { x: -hw + 10.2, zEdge: zOut, yE0: yOut0, yE1: yOut1 },
      { x: 0.8, zEdge: zOut, yE0: yOut0, yE1: yOut1 },
      { x: hw - 0.1, zEdge: zNose, yE0: 1.0, yE1: 3.0 },
    ];
    addLoftedSolidX(
      extrudeGroup,
      wingSections.map((s) => ({ x: s.x, pts: makeWingRing(s.zEdge, s.yE0, s.yE1) })),
      fillBase
    );
    // Crisp top/bottom outline ridges & diagonal panel seam matching PAK TOP/SIDE views
    for (let i = 0; i < wingSections.length - 1; i++) {
      const a = wingSections[i];
      const b = wingSections[i + 1];
      pushSeg(primaryPts, a.x, a.zEdge, b.x, b.zEdge, a.yE1 + 0.02, b.yE1 + 0.02);
      pushSeg(primaryPts, a.x, a.zEdge, b.x, b.zEdge, a.yE0 - 0.02, b.yE0 - 0.02);
      pushSeg(primaryPts, a.x, zBase, b.x, zBase, yIn1 + 0.02, yIn1 + 0.02);
      pushSeg(detailPts, a.x, zBase, b.x, zBase, yIn0 - 0.02, yIn0 - 0.02);
    }
    // End vertical ridges & signature diagonal armor plate seam + aft vent ribs
    for (const idx of [0, 2, 5, 6, 7]) {
      const s = wingSections[idx];
      pushSeg(primaryPts, s.x, zBase, s.x, s.zEdge, yIn1 + 0.02, s.yE1 + 0.02);
      pushSeg(detailPts, s.x, zBase, s.x, s.zEdge, yIn0 - 0.02, s.yE0 - 0.02);
      pushSeg(detailPts, s.x, s.zEdge, s.x, s.zEdge, s.yE0, s.yE1);
    }
    // Signature swept diagonal panel crease separating forward prow wedge from main flank
    pushSeg(primaryPts, 0.8, zOut, -1.6, zBase, yOut1 + 0.03, yIn1 + 0.03);
    pushSeg(detailPts, 0.8, zOut, -1.6, zBase, yOut0 - 0.03, yIn0 - 0.03);
    pushSeg(detailPts, -hw + 6.2, zNotch, -hw + 9.4, zNotch, 2.0, 2.0);
  } else if (id.startsWith('BPO_ArmourSlope_')) {
    // Authentic PAK chamfered faceted armour wedge (1x1 or 2x1, top slope T or underside slope B!)
    const isBot = id.endsWith('B');
    const isLong = id.includes('_02');
    roofHeight = 4.0;
    const xBack = -hw + 0.06;
    const xFront = hw - 0.06;
    const zFull = hd - 0.06;
    const zChamfBack = hd - 1.15; // 45-degree chamfered shoulders
    const zChamfFront = isLong ? hd - 1.75 : hd - 1.25;
    const zNoseOuter = isLong ? hd - 0.72 : hd - 0.24;

    // Cross-section builder (6-vertex beveled trapezoid in YZ plane: flat mounting face + 45° chamfered side skirts + sloped deck!)
    const makeSlopeRing = (yFlat: number, ySlope: number, yShoulder: number, zOut: number, zTop: number): Array<[number, number]> =>
      !isBot
        ? [
            [yFlat, -zOut],
            [yFlat, zOut],
            [yShoulder, zOut],
            [ySlope, zTop],
            [ySlope, -zTop],
            [yShoulder, -zOut],
          ]
        : [
            [yFlat, -zOut],
            [yShoulder, -zOut],
            [ySlope, -zTop],
            [ySlope, zTop],
            [yShoulder, zOut],
            [yFlat, zOut],
          ];

    const yFlat = isBot ? 4.0 : 0.0;
    const yBackSlope = isBot ? 0.02 : 3.98;
    const yBackShoulder = isBot ? 1.05 : 2.95;
    const yMidX = isLong ? 1.6 : 0.0;
    const yMidSlope = isBot ? 2.15 : 1.85;
    const yMidShoulder = isBot ? 2.65 : 1.35;
    const yFrontSlope = isBot ? 3.35 : 0.65;
    const yFrontShoulder = isBot ? 3.55 : 0.45;

    const slopeRings = isLong
      ? [
          { x: xBack, zOut: zFull, zTop: zChamfBack, yS: yBackSlope, ySh: yBackShoulder },
          { x: yMidX, zOut: zFull, zTop: zChamfBack + 0.15, yS: yMidSlope, ySh: yMidShoulder },
          { x: xFront - 0.75, zOut: zFull - 0.25, zTop: zChamfFront, yS: isBot ? 3.25 : 0.75, ySh: isBot ? 3.48 : 0.52 },
          { x: xFront, zOut: zNoseOuter, zTop: zChamfFront - 0.25, yS: yFrontSlope, ySh: yFrontShoulder },
        ]
      : [
          { x: xBack, zOut: zFull, zTop: zChamfBack, yS: yBackSlope, ySh: yBackShoulder },
          { x: xFront - 0.55, zOut: zFull, zTop: zChamfFront, yS: isBot ? 3.18 : 0.82, ySh: isBot ? 3.42 : 0.58 },
          { x: xFront, zOut: zNoseOuter, zTop: zChamfFront - 0.15, yS: yFrontSlope, ySh: yFrontShoulder },
        ];

    addLoftedSolidX(
      extrudeGroup,
      slopeRings.map((r) => ({ x: r.x, pts: makeSlopeRing(yFlat, r.yS, r.ySh, r.zOut, r.zTop) })),
      fillBase
    );

    const eps = isBot ? -0.025 : 0.025;
    // Longitudinal chamfered ridge lines & outer gunwale edges
    for (let i = 0; i < slopeRings.length - 1; i++) {
      const a = slopeRings[i];
      const b = slopeRings[i + 1];
      for (const s of [-1, 1]) {
        pushSeg(primaryPts, a.x, s * a.zTop, b.x, s * b.zTop, a.yS + eps, b.yS + eps);
        pushSeg(primaryPts, a.x, s * a.zOut, b.x, s * b.zOut, a.ySh + eps, b.ySh + eps);
        pushSeg(detailPts, a.x, s * a.zOut, b.x, s * b.zOut, yFlat, yFlat);
      }
    }
    // Back bulkhead perimeter, front beveled lip, and rear inset connector port outline (seen in PAK FRONT/ISO!)
    const firstR = slopeRings[0];
    const lastR = slopeRings[slopeRings.length - 1];
    pushSeg(primaryPts, firstR.x, -firstR.zTop, firstR.x, firstR.zTop, firstR.yS + eps, firstR.yS + eps);
    pushSeg(primaryPts, lastR.x, -lastR.zTop, lastR.x, lastR.zTop, lastR.yS + eps, lastR.yS + eps);
    for (const s of [-1, 1]) {
      pushSeg(primaryPts, firstR.x, s * firstR.zTop, firstR.x, s * firstR.zOut, firstR.yS + eps, firstR.ySh + eps);
      pushSeg(primaryPts, lastR.x, s * lastR.zTop, lastR.x, s * lastR.zOut, lastR.yS + eps, lastR.ySh + eps);
      pushSeg(detailPts, firstR.x, s * firstR.zOut, firstR.x, s * firstR.zOut, yFlat, firstR.ySh);
      pushSeg(detailPts, lastR.x, s * lastR.zOut, lastR.x, s * lastR.zOut, yFlat, lastR.ySh);
    }
    // Rear recessed square bulkhead collar on -X face
    const portY0 = isBot ? 1.55 : 0.95;
    const portY1 = isBot ? 3.05 : 2.45;
    pushSeg(detailPts, xBack - 0.03, -1.25, xBack - 0.03, 1.25, portY0, portY0);
    pushSeg(detailPts, xBack - 0.03, -1.25, xBack - 0.03, 1.25, portY1, portY1);
    pushSeg(detailPts, xBack - 0.03, -1.25, xBack - 0.03, -1.25, portY0, portY1);
    pushSeg(detailPts, xBack - 0.03, 1.25, xBack - 0.03, 1.25, portY0, portY1);

    if (isLong) {
      // Iconic PAK central tapered dorsal/ventral armor spine groove on 2x1 slope!
      const spineRearX = xBack + 0.6;
      const spineTipX = 1.9;
      const spineRearY = isBot ? 0.25 : 3.75;
      const spineTipY = isBot ? 2.22 : 1.78;
      pushSeg(primaryPts, spineRearX, -1.85, spineTipX, -1.05, spineRearY + eps, spineTipY + eps);
      pushSeg(primaryPts, spineRearX, 1.85, spineTipX, 1.05, spineRearY + eps, spineTipY + eps);
      pushSeg(primaryPts, spineTipX, -1.05, spineTipX, 1.05, spineTipY + eps, spineTipY + eps);
      pushSeg(detailPts, spineRearX, -1.85, spineRearX, 1.85, spineRearY + eps, spineRearY + eps);
      // Mid transverse hull rib across the 2x1 deck
      const mR = slopeRings[1];
      pushSeg(detailPts, mR.x, -mR.zTop, mR.x, mR.zTop, mR.yS + eps, mR.yS + eps);
    } else {
      // 1x1 forward beveled lip crease matching PAK TOP/ISO view
      const pR = slopeRings[1];
      pushSeg(detailPts, pR.x, -pR.zTop, pR.x, pR.zTop, pR.yS + eps, pR.yS + eps);
      pushSeg(detailPts, firstR.x + 0.85, -1.65, pR.x, -1.35, (isBot ? 0.65 : 3.35) + eps, pR.yS + eps);
      pushSeg(detailPts, firstR.x + 0.85, 1.65, pR.x, 1.35, (isBot ? 0.65 : 3.35) + eps, pR.yS + eps);
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
