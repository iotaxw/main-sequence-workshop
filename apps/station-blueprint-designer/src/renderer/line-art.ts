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

/**
 * Restrained architectural line-art geometry builders (planar / ultra-low-profile).
 * Designed for unmistakable recognition without text or chunky 3D boxes.
 */

// Unified dark-CAD low-saturation palette (no loud neon or solid color blocks!)
export const LINE_ART_PALETTE = {
  baseFill: 0x0d131c,
  baseFillSelected: 0x131d2b,
  linePrimary: 0x6f849c,
  lineSecondary: 0x3b4d63,
  lineDetail: 0x4f647d,
  lineSelected: 0xa8c5e0,
  beltTrackFill: 0x0e1520,
  beltRailMk1: 0x4b5c70,
  beltRailMk2: 0x67839e,
  beltRailMk3: 0x869db8,
  beltArrow: 0x7e96b0,
  portActiveLine: 0x4ea377,   // Restrained sage-emerald hairline (hollow)
  portDisabledLine: 0x7c383c, // Quiet muted crimson hairline (hollow cross)
  researchTint: 0x5c8b8f,
  powerTint: 0x998752,
};

function pushSeg(out: number[], x1: number, z1: number, x2: number, z2: number, y = 0): void {
  out.push(x1, y, z1, x2, y, z2);
}

function pushRect(out: number[], hw: number, hd: number, y = 0, chamfer = 0): void {
  if (chamfer <= 0) {
    pushSeg(out, -hw, -hd, hw, -hd, y);
    pushSeg(out, hw, -hd, hw, hd, y);
    pushSeg(out, hw, hd, -hw, hd, y);
    pushSeg(out, -hw, hd, -hw, -hd, y);
    return;
  }
  const c = Math.min(chamfer, hw * 0.45, hd * 0.45);
  const pts: Array<[number, number]> = [
    [-hw + c, -hd],
    [hw - c, -hd],
    [hw, -hd + c],
    [hw, hd - c],
    [hw - c, hd],
    [-hw + c, hd],
    [-hw, hd - c],
    [-hw, -hd + c],
  ];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    pushSeg(out, a[0], a[1], b[0], b[1], y);
  }
}

function pushPolygon(out: number[], r: number, sides: number, y = 0, rotOffset = 0): void {
  for (let i = 0; i < sides; i++) {
    const a0 = rotOffset + (i / sides) * Math.PI * 2;
    const a1 = rotOffset + ((i + 1) / sides) * Math.PI * 2;
    pushSeg(out, Math.cos(a0) * r, Math.sin(a0) * r, Math.cos(a1) * r, Math.sin(a1) * r, y);
  }
}

function pushChevron(out: number[], cx: number, cz: number, size: number, y = 0): void {
  pushSeg(out, cx - size * 0.45, cz - size * 0.48, cx + size * 0.48, cz, y);
  pushSeg(out, cx + size * 0.48, cz, cx - size * 0.45, cz + size * 0.48, y);
}

function buildLineSegments(pts: number[], color: number, opacity: number): THREE.LineSegments {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const mat = new THREE.LineBasicMaterial({
    color,
    transparent: opacity < 0.99,
    opacity,
  });
  return new THREE.LineSegments(geo, mat);
}

function buildHollowPortMarker(
  wx: number,
  y: number,
  wz: number,
  enabled: boolean,
  opacity: number
): THREE.LineSegments {
  const pts: number[] = [];
  const r = 0.17;
  if (enabled) {
    // Crisp hollow diamond/octagon ring (no cheap filled cube!)
    pushPolygon(pts, r, 8, 0, Math.PI / 8);
    // Tiny inner dot-crosshair
    pushSeg(pts, -0.04, 0, 0.04, 0, 0);
    pushSeg(pts, 0, -0.04, 0, 0.04, 0);
  } else {
    // Muted hollow square with subtle X
    pushRect(pts, r * 0.78, r * 0.78, 0, 0);
    const x = r * 0.52;
    pushSeg(pts, -x, -x, x, x, 0);
    pushSeg(pts, x, -x, -x, x, 0);
  }
  const segs = buildLineSegments(
    pts,
    enabled ? LINE_ART_PALETTE.portActiveLine : LINE_ART_PALETTE.portDisabledLine,
    opacity * (enabled ? 0.9 : 0.65)
  );
  segs.position.set(wx, y, wz);
  return segs;
}

/**
 * Minimalist continuous conveyor belt line-art:
 * Two clean parallel rails (no distracting tile divider seams!) + smooth corner rails + tiny tier chevron.
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

  // Determine incoming direction from any neighbor belt/splitter pointing INTO this cell
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
      inDir = [-dx, -dy]; // direction items travel into this tile
      break;
    }
  }

  // Transform incoming direction into belt-local frame (where +X is outgoing)
  let localTurn: 'straight' | 'left' | 'right' = 'straight';
  if (inDir) {
    // cross = inDir.x * outDy - inDir.y * outDx
    const cross = inDir[0] * outDy - inDir[1] * outDx;
    if (cross > 0) localTurn = 'right';
    else if (cross < 0) localTurn = 'left';
  }

  // Ultra-subtle recessed belt bed (nearly invisible, gives gentle figure-ground separation)
  const bedGeo = new THREE.PlaneGeometry(0.98, 0.54);
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
  const r = 0.27; // rail half-width

  if (localTurn === 'straight') {
    // Open-ended parallel rails (seamless across consecutive tiles!)
    pushSeg(railPts, -0.5, -r, 0.5, -r, 0);
    pushSeg(railPts, -0.5, r, 0.5, r, 0);
  } else if (localTurn === 'right') {
    // Incoming from -Z (top in local), turning to +X
    // Outer rail: (-r, -0.5) -> (-r, r) -> (0.5, r)
    pushSeg(railPts, -r, -0.5, -r, r * 0.45, 0);
    pushSeg(railPts, -r, r * 0.45, -r * 0.45, r, 0);
    pushSeg(railPts, -r * 0.45, r, 0.5, r, 0);
    // Inner rail: (r, -0.5) -> (r, -r) -> (0.5, -r)
    pushSeg(railPts, r, -0.5, r, -r, 0);
    pushSeg(railPts, r, -r, 0.5, -r, 0);
  } else {
    // Incoming from +Z (bottom in local), turning to +X
    // Outer rail: (-r, 0.5) -> (-r, -r) -> (0.5, -r)
    pushSeg(railPts, -r, 0.5, -r, -r * 0.45, 0);
    pushSeg(railPts, -r, -r * 0.45, -r * 0.45, -r, 0);
    pushSeg(railPts, -r * 0.45, -r, 0.5, -r, 0);
    // Inner rail: (r, 0.5) -> (r, r) -> (0.5, r)
    pushSeg(railPts, r, 0.5, r, r, 0);
    pushSeg(railPts, r, r, 0.5, r, 0);
  }

  const railColor = isSelected
    ? LINE_ART_PALETTE.lineSelected
    : def.tier === 3
      ? LINE_ART_PALETTE.beltRailMk3
      : def.tier === 2
        ? LINE_ART_PALETTE.beltRailMk2
        : LINE_ART_PALETTE.beltRailMk1;

  const railLines = buildLineSegments(railPts, railColor, opacity * (isSelected ? 1.0 : 0.78));
  railLines.position.set(cx, y + 0.01, cz);
  railLines.rotation.y = -b.rotation * (Math.PI / 2);
  group.add(railLines);

  // Subtle compact directional chevron (1, 2, or 3 nested ticks for Mk.1 / Mk.2 / Mk.3!)
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
    opacity * (isSelected ? 1.0 : 0.72)
  );
  chevLines.position.set(cx, y + 0.015, cz);
  chevLines.rotation.y = -b.rotation * (Math.PI / 2);
  group.add(chevLines);

  return group;
}

/**
 * Build crisp planar architectural line-art for any non-belt building/machine.
 * Every building class has its own distinct geometric drafting glyph so it's readable without labels!
 */
export function buildMachineLineArt(
  b: PlacedBuilding,
  def: BuildableDef,
  baseY: number,
  opacity: number,
  isSelected: boolean
): THREE.Group {
  const group = new THREE.Group();
  const [cx, cz] = getBuildingCenterM(b, def);
  const [w, d] = getBuildingSizeCells(def, b.rotation);
  const y = baseY + 0.04;

  // Local unrotated dimensions (geometry rotates by -b.rotation * PI/2)
  const lw = def.size[0];
  const ld = def.size[1];
  const inset = Math.min(lw, ld) >= 3 ? 0.14 : 0.08;
  const hw = lw / 2 - inset;
  const hd = ld / 2 - inset;
  const minH = Math.min(hw, hd);

  // 1. Whisper-dark flat architectural baseplate (keeps floor cleanly masked beneath linework)
  const plateGeo = new THREE.PlaneGeometry(w - inset * 2, d - inset * 2);
  plateGeo.rotateX(-Math.PI / 2);
  const plateMat = new THREE.MeshBasicMaterial({
    color: isSelected ? LINE_ART_PALETTE.baseFillSelected : LINE_ART_PALETTE.baseFill,
    transparent: true,
    opacity: opacity * 0.94,
    depthWrite: false,
  });
  const plate = new THREE.Mesh(plateGeo, plateMat);
  plate.position.set(cx, y, cz);
  group.add(plate);

  // 2. Outer + Inner architectural drafting strokes (in local unrotated space, then rotated)
  const primaryPts: number[] = [];
  const detailPts: number[] = [];

  const primaryColor = isSelected
    ? LINE_ART_PALETTE.lineSelected
    : def.kind === 'research'
      ? LINE_ART_PALETTE.researchTint
      : def.kind === 'reactor'
        ? LINE_ART_PALETTE.powerTint
        : LINE_ART_PALETTE.linePrimary;

  switch (def.id) {
    case 'DAT_Refinery': {
      // Chamfered square + thermal core ring + 4 diagonal ribs
      pushRect(primaryPts, hw, hd, 0, 0.32);
      pushPolygon(primaryPts, minH * 0.56, 16, 0);
      pushPolygon(detailPts, minH * 0.28, 8, 0, Math.PI / 8);
      const r0 = minH * 0.56;
      const r1 = minH * 0.92;
      for (let i = 0; i < 4; i++) {
        const a = Math.PI / 4 + (i * Math.PI) / 2;
        pushSeg(detailPts, Math.cos(a) * r0, Math.sin(a) * r0, Math.cos(a) * r1, Math.sin(a) * r1);
      }
      break;
    }

    case 'DAT_Assembler': {
      // Chamfered precision housing + inner gantry frame + central diamond
      pushRect(primaryPts, hw, hd, 0, 0.36);
      pushRect(detailPts, hw * 0.72, hd * 0.72, 0, 0.16);
      pushPolygon(primaryPts, minH * 0.34, 4, 0, 0);
      pushSeg(detailPts, -hw * 0.72, 0, -minH * 0.34, 0);
      pushSeg(detailPts, minH * 0.34, 0, hw * 0.72, 0);
      pushSeg(detailPts, 0, -hd * 0.72, 0, -minH * 0.34);
      pushSeg(detailPts, 0, minH * 0.34, 0, hd * 0.72);
      break;
    }

    case 'DAT_AdvancedAssembler': {
      // Heavy double-framed 9x9 assembly bay with 2x2 internal cells + central rotated hub
      pushRect(primaryPts, hw, hd, 0, 0.55);
      pushRect(detailPts, hw * 0.84, hd * 0.84, 0, 0.3);
      pushSeg(detailPts, -hw * 0.84, 0, hw * 0.84, 0);
      pushSeg(detailPts, 0, -hd * 0.84, 0, hd * 0.84);
      pushPolygon(primaryPts, minH * 0.42, 4, 0, 0);
      pushRect(primaryPts, minH * 0.2, minH * 0.2, 0, 0);
      break;
    }

    case 'DAT_EnrichmentChamber': {
      // Centrifuge / enrichment chamber: outer octagon-chamfer + 3 concentric separation rings
      pushRect(primaryPts, hw, hd, 0, 0.85);
      pushPolygon(primaryPts, minH * 0.78, 24, 0);
      pushPolygon(detailPts, minH * 0.54, 24, 0);
      pushPolygon(primaryPts, minH * 0.28, 12, 0);
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3;
        pushSeg(detailPts, Math.cos(a) * minH * 0.28, Math.sin(a) * minH * 0.28, Math.cos(a) * minH * 0.78, Math.sin(a) * minH * 0.78);
      }
      break;
    }

    case 'DAT_Supercomputer': {
      // 7x7 compute cluster: crisp architectural frame + 4 parallel server blade arrays + core bus
      pushRect(primaryPts, hw, hd, 0, 0.35);
      for (const sx of [-1.9, -0.7, 0.7, 1.9]) {
        pushRect(detailPts, 0.34, hd * 0.74, 0, 0.08);
        // Shift blade into place manually
        for (let k = detailPts.length - 48; k < detailPts.length; k += 3) {
          detailPts[k] += sx;
        }
      }
      pushSeg(primaryPts, -hw * 0.82, 0, hw * 0.82, 0);
      pushRect(primaryPts, 0.65, 0.65, 0, 0.12);
      break;
    }

    case 'DAT_GrowthChamber': {
      // 7x7 bio-chamber: rounded-chamfer frame + nested hexagonal lattice
      pushRect(primaryPts, hw, hd, 0, 0.65);
      pushPolygon(primaryPts, minH * 0.72, 6, 0, 0);
      pushPolygon(detailPts, minH * 0.42, 6, 0, Math.PI / 6);
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3;
        pushSeg(detailPts, 0, 0, Math.cos(a) * minH * 0.72, Math.sin(a) * minH * 0.72);
      }
      break;
    }

    case 'DAT_RelicSynthesizer': {
      // 9x9 relic synthesizer: double rotated star-rhombus + inner core
      pushRect(primaryPts, hw, hd, 0, 0.9);
      pushPolygon(primaryPts, minH * 0.78, 8, 0, Math.PI / 8);
      pushPolygon(detailPts, minH * 0.62, 4, 0, 0);
      pushPolygon(detailPts, minH * 0.62, 4, 0, Math.PI / 4);
      pushPolygon(primaryPts, minH * 0.24, 16, 0);
      break;
    }

    case 'DAT_ReactorMachine': {
      // 6x6 reactor: double octagonal containment + 3 radial core arms
      pushRect(primaryPts, hw, hd, 0, 0.65);
      pushPolygon(primaryPts, minH * 0.76, 8, 0, Math.PI / 8);
      pushPolygon(detailPts, minH * 0.48, 16, 0);
      pushPolygon(primaryPts, minH * 0.2, 12, 0);
      for (let i = 0; i < 3; i++) {
        const a = -Math.PI / 2 + (i * Math.PI * 2) / 3;
        pushSeg(primaryPts, Math.cos(a) * minH * 0.2, Math.sin(a) * minH * 0.2, Math.cos(a) * minH * 0.76, Math.sin(a) * minH * 0.76);
      }
      break;
    }

    case 'DAT_Container':
    case 'DAT_Container_2': {
      // Clean modular storage bays (no bulky crate!)
      pushRect(primaryPts, hw, hd, 0, 0.2);
      const div = def.id === 'DAT_Container_2' ? 3 : 2;
      for (let i = 1; i < div; i++) {
        const x = -hw + (hw * 2 * i) / div;
        const z = -hd + (hd * 2 * i) / div;
        pushSeg(detailPts, x, -hd * 0.85, x, hd * 0.85);
        pushSeg(detailPts, -hw * 0.85, z, hw * 0.85, z);
      }
      break;
    }

    case 'DAT_Splitter':
    case 'DAT_Splitter_2':
    case 'DAT_Splitter_3': {
      // Crisp 1x1 splitter: clean frame + 1-to-3 branching flow lines
      pushRect(primaryPts, hw, hd, 0, 0.1);
      pushSeg(primaryPts, -hw, 0, hw * 0.85, 0);
      pushSeg(primaryPts, 0, -hd * 0.85, 0, hd * 0.85);
      pushChevron(primaryPts, hw * 0.48, 0, 0.22);
      // Tiny tier tick marks on input side
      for (let t = 0; t < def.tier; t++) {
        const tz = (t - (def.tier - 1) / 2) * 0.14;
        pushSeg(detailPts, -hw * 0.65, tz, -hw * 0.35, tz);
      }
      break;
    }

    case 'DAT_BeltBalancer_01':
    case 'DAT_BeltBalancer_02':
    case 'DAT_BeltBalancer_03': {
      // Crisp 1x2 balancer: twin lane X-crossover weave!
      pushRect(primaryPts, hw, hd, 0, 0.1);
      pushSeg(primaryPts, -hw, -0.5, hw, 0.5);
      pushSeg(primaryPts, -hw, 0.5, hw, -0.5);
      pushChevron(detailPts, hw * 0.55, -0.5, 0.18);
      pushChevron(detailPts, hw * 0.55, 0.5, 0.18);
      break;
    }

    case 'DAT_UndergroundBelt':
    case 'DAT_UndergroundBelt_2':
    case 'DAT_UndergroundBelt_3': {
      // Open architectural portal bracket [ + single flow chevron
      const isOut = b.undergroundMode === 'out';
      if (!isOut) {
        // Entry hood facing +X (open on -X, hooded on +X)
        pushSeg(primaryPts, -hw * 0.3, -hd, hw, -hd);
        pushSeg(primaryPts, hw, -hd, hw, hd);
        pushSeg(primaryPts, hw, hd, -hw * 0.3, hd);
        pushSeg(detailPts, hw * 0.45, -hd * 0.72, hw * 0.45, hd * 0.72);
      } else {
        // Exit hood facing +X (hooded on -X, open on +X)
        pushSeg(primaryPts, hw * 0.3, -hd, -hw, -hd);
        pushSeg(primaryPts, -hw, -hd, -hw, hd);
        pushSeg(primaryPts, -hw, hd, hw * 0.3, hd);
        pushSeg(detailPts, -hw * 0.45, -hd * 0.72, -hw * 0.45, hd * 0.72);
      }
      pushChevron(primaryPts, 0, 0, 0.26);
      break;
    }

    case 'DAT_Teleporter': {
      pushRect(primaryPts, hw, hd, 0, 0.4);
      pushPolygon(primaryPts, minH * 0.76, 20, 0);
      pushPolygon(detailPts, minH * 0.5, 20, 0);
      pushPolygon(primaryPts, minH * 0.24, 12, 0);
      break;
    }

    default: {
      if (def.kind === 'research') {
        // Research labs: sleek dish/reticle with tier-distinctive concentric circles + forward pointer
        pushRect(primaryPts, hw, hd, 0, Math.min(0.45, minH * 0.25));
        const rings = lw >= 9 ? 3 : lw >= 5 ? 2 : 1;
        for (let i = 1; i <= rings; i++) {
          const rad = minH * (0.25 + (0.52 * i) / rings);
          pushPolygon(i === rings ? primaryPts : detailPts, rad, 20, 0);
        }
        pushSeg(detailPts, -minH * 0.78, 0, minH * 0.78, 0);
        pushSeg(detailPts, 0, -minH * 0.78, 0, minH * 0.78);
        pushChevron(primaryPts, hw * 0.65, 0, Math.min(0.45, minH * 0.32));
      } else {
        // Workbench / Armoury / Decorations: clean minimalist architectural rectangle + cross
        pushRect(primaryPts, hw, hd, 0, Math.min(0.25, minH * 0.25));
        pushRect(detailPts, hw * 0.65, hd * 0.65, 0, 0.08);
      }
      break;
    }
  }

  const artHolder = new THREE.Group();
  artHolder.position.set(cx, y + 0.02, cz);
  artHolder.rotation.y = -b.rotation * (Math.PI / 2);

  if (primaryPts.length > 0) {
    artHolder.add(buildLineSegments(primaryPts, primaryColor, opacity * (isSelected ? 1.0 : 0.88)));
  }
  if (detailPts.length > 0) {
    artHolder.add(
      buildLineSegments(
        detailPts,
        isSelected ? LINE_ART_PALETTE.linePrimary : LINE_ART_PALETTE.lineDetail,
        opacity * (isSelected ? 0.85 : 0.58)
      )
    );
  }
  group.add(artHolder);

  // 3. Restrained hollow line-art ports (NO bright filled blocks!)
  if (def.configurablePorts) {
    const worldPorts = getBuildingWorldPorts(b, def);
    for (const wp of worldPorts) {
      group.add(buildHollowPortMarker(wp.worldX, y + 0.03, wp.worldY, wp.enabled, opacity));
    }
  }

  return group;
}
