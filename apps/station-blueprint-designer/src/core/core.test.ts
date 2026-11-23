import { describe, expect, it } from 'vitest';
import { buildPlannedBeltPath, extendBeltStroke, selectConnectedBeltChain } from './belt-router';
import { CATALOG, getBuildableDef, getModuleDef, getRecipeDef, getRecipesForCrafter } from './catalog';
import { createStarterBlueprint, deserializeBlueprint, serializeBlueprint } from './codec';
import {
  boxSelectEntities,
  commitHistory,
  createEmptyBlueprint,
  createHistory,
  deleteSelectionCmd,
  extractSelectionAsBlueprint,
  mirrorBlueprintX,
  placeBeltRunCmd,
  placeBuildingCmd,
  placeModuleCmd,
  redoHistory,
  rotateBlueprint,
  stampBlueprintCmd,
  undoHistory,
  updateBuildingConfigCmd,
} from './commands';
import {
  computeUndergroundLinks,
  getModuleWorldConnectors,
  isCellBuildable,
  validateBuildingPlacement,
  validateModulePlacement,
} from './geometry';
import { BUILDING_GROUPS, cycleVariantInGroup, getShortLabel, STATION_GROUPS } from './groups';
import { DEFAULT_LIBRARY_PRESETS } from './presets';
import { simulateBlueprint } from './simulation';
import { CadCameraRig, MAX_DISTANCE } from '../renderer/camera-rig';

describe('Build 26639889 catalog verification', () => {
  it('includes all extracted station modules, buildables, and recipes with binary-verified dimensions', () => {
    expect(CATALOG.game.buildId).toBe('26639889');
    expect(CATALOG.stationModules.length).toBeGreaterThanOrEqual(27);
    expect(getModuleDef('BPO_StationArmour_01B')?.blockBoundsM?.minZ).toBeLessThan(0);
    expect(CATALOG.buildables.length).toBeGreaterThanOrEqual(33);
    expect(CATALOG.recipes.length).toBeGreaterThanOrEqual(80);

    // Binary-verified 7x7 bounds for Supercomputer & Growth Chamber
    expect(getBuildableDef('DAT_Supercomputer')?.size).toEqual([7, 7]);
    expect(getBuildableDef('DAT_GrowthChamber')?.size).toEqual([7, 7]);
    expect(getBuildableDef('DAT_Assembler')?.size).toEqual([5, 5]);
    expect(getBuildableDef('DAT_AdvancedAssembler')?.size).toEqual([9, 9]);

    // Binary-verified 2x2 B dual-floor with L+1 ring balcony
    const modB = getModuleDef('BPO_Station_02');
    expect(modB?.sizeUnits).toEqual([2, 2, 2]);
    expect(modB?.floors.length).toBe(2);
    expect(modB?.floors[1].shape).toBe('ring');

    // Recipes linked to crafter types
    expect(getRecipesForCrafter('CRAFT_Assembler').length).toBeGreaterThan(5);
  });

  it('maps 100% of buildables and station modules into shapez-2 style hotkey groups with clean Tab cycling', () => {
    const allGroupedBuildings = BUILDING_GROUPS.flatMap((g) => g.members);
    const catalogBuildingIds = CATALOG.buildables.map((b) => b.id);
    expect(new Set(allGroupedBuildings)).toEqual(new Set(catalogBuildingIds));
    expect(allGroupedBuildings.length).toBe(catalogBuildingIds.length);

    const allGroupedModules = STATION_GROUPS.flatMap((g) => g.members);
    const catalogModuleIds = CATALOG.stationModules.map((m) => m.id);
    expect(new Set(allGroupedModules)).toEqual(new Set(catalogModuleIds));
    expect(allGroupedModules.length).toBe(catalogModuleIds.length);

    // Station groups: Factory -> Function -> Other -> Connect (Elevators first inside Connect)
    expect(STATION_GROUPS.map((g) => g.name)).toEqual(['工厂模块', '功能模块', '其它模块', '连接模块']);
    expect(STATION_GROUPS[3].members.slice(0, 2)).toEqual(['BPO_ElevatorBlock_03', 'BPO_ElevatorBlock_02A']);
    // Buildings: Logistics -> Production -> Labs -> Facilities -> Decor last
    expect(BUILDING_GROUPS[BUILDING_GROUPS.length - 1].name).toBe('装饰');

    // Tab forward & Shift+Tab backward wrap cleanly inside Balancers & Labs
    expect(cycleVariantInGroup('building', 'DAT_BeltBalancer_01', 1)).toBe('DAT_BeltBalancer_02');
    expect(cycleVariantInGroup('building', 'DAT_BeltBalancer_03', 1)).toBe('DAT_BeltBalancer_01');
    expect(cycleVariantInGroup('building', 'DAT_BeltBalancer_01', -1)).toBe('DAT_BeltBalancer_03');
    expect(getShortLabel('DAT_BeltBalancer_03')).toBe('平衡器 III');
    expect(getShortLabel('DAT_QuantumSciLab')).toBe('实验室 IV');
  });
});

describe('Station floors, 2x2 B ring balcony, and doorway continuity', () => {
  it('enforces exact 3-cell wide ring balcony on 2x2 B floor L+1', () => {
    let doc = createEmptyBlueprint();
    doc = placeModuleCmd(doc, { type: 'BPO_Station_02', gx: 0, gy: 0, floor: 0, rotation: 0 }).doc;
    // Center of 2x2 module at gx=0,gy=0 is (16,16). Ring spans [1..30] with central hole (4..28) -> cells [1..3] & [28..30]!
    expect(isCellBuildable(doc, 1, 1, 1)).not.toBeNull();
    expect(isCellBuildable(doc, 3, 10, 1)).not.toBeNull();
    // Central void at (16, 16) on L+1 must NOT be buildable
    expect(isCellBuildable(doc, 16, 16, 1)).toBeNull();
    // Ground floor L0 center IS buildable
    expect(isCellBuildable(doc, 16, 16, 0)).not.toBeNull();

    // 3x3 Refinery fits cleanly on the 3-cell wide L+1 ring balcony (x=1..3, y=5..7)
    const refIssue = validateBuildingPlacement(doc, { type: 'DAT_Refinery', x: 1, y: 5, floor: 1, rotation: 0 });
    expect(refIssue).toBeNull();

    // 4x4 Large Container overlaps central void on L+1 and MUST be rejected
    const bigIssue = validateBuildingPlacement(doc, { type: 'DAT_Container_2', x: 1, y: 5, floor: 1, rotation: 0 });
    expect(bigIssue?.kind).toBe('no-floor');
  });

  it('allows belts to cross doorways seamlessly between adjacent 2x2 A modules', () => {
    let doc = createEmptyBlueprint();
    doc = placeModuleCmd(doc, { type: 'BPO_Station_02A', gx: 0, gy: 0, floor: 0, rotation: 0 }).doc;
    doc = placeModuleCmd(doc, { type: 'BPO_Station_02A', gx: 2, gy: 0, floor: 0, rotation: 0 }).doc;
    // Doorway aligns at y=7 (local y=-9, inside [-11,-5]) across x=31 (East edge of left mod) -> x=32 (West edge of right mod)
    const res = placeBeltRunCmd(doc, 'DAT_ConveyorBelt', 0, [
      { x: 30, y: 7, rotation: 0 },
      { x: 31, y: 7, rotation: 0 },
      { x: 32, y: 7, rotation: 0 },
      { x: 33, y: 7, rotation: 0 },
    ]);
    expect(res.changed).toBe(true);
    expect(res.addedBuildingIds?.length).toBe(4);
  });
});

describe('Belt router, Belt Planner, underground pairing, and connected selection', () => {
  it('interpolates fast drags without gaps and supports Shift Belt Planner L-flip and reverse', () => {
    let stroke: Array<[number, number]> = [[2, 2]];
    stroke = extendBeltStroke(stroke, [6, 4]);
    expect(stroke[0]).toEqual([2, 2]);
    expect(stroke[stroke.length - 1]).toEqual([6, 4]);
    // Every consecutive pair must be Manhattan distance 1
    for (let i = 1; i < stroke.length; i++) {
      const dist = Math.abs(stroke[i][0] - stroke[i - 1][0]) + Math.abs(stroke[i][1] - stroke[i - 1][1]);
      expect(dist).toBe(1);
    }

    const planA = buildPlannedBeltPath([1, 1], [4, 3], { flipCorner: false, reverse: false, fallbackRotation: 0 });
    const planB = buildPlannedBeltPath([1, 1], [4, 3], { flipCorner: true, reverse: false, fallbackRotation: 0 });
    expect(planA[1].x).toBe(2);
    expect(planB[1].y).toBe(2);
    const planRev = buildPlannedBeltPath([1, 1], [4, 1], { flipCorner: false, reverse: true, fallbackRotation: 0 });
    expect(planRev[0].rotation).toBe(2); // Reversed westward!
  });

  it('pairs underground belts up to 8 cells and selects connected chain via O key logic', () => {
    let doc = createEmptyBlueprint();
    doc = placeModuleCmd(doc, { type: 'BPO_Station_02A', gx: 0, gy: 0, floor: 0, rotation: 0 }).doc;
    doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt', x: 4, y: 6, floor: 0, rotation: 0 }).doc;
    const ugIn = placeBuildingCmd(doc, {
      type: 'DAT_UndergroundBelt',
      x: 5,
      y: 6,
      floor: 0,
      rotation: 0,
      undergroundMode: 'in',
    });
    doc = ugIn.doc;
    doc = placeBuildingCmd(doc, {
      type: 'DAT_UndergroundBelt',
      x: 11,
      y: 6,
      floor: 0,
      rotation: 0,
      undergroundMode: 'out',
    }).doc;
    doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt', x: 12, y: 6, floor: 0, rotation: 0 }).doc;

    const links = computeUndergroundLinks(doc);
    expect(links.length).toBe(1);
    expect(links[0].x2 - links[0].x1).toBe(6);

    const chain = selectConnectedBeltChain(doc, ugIn.addedBuildingIds![0]);
    expect(chain.length).toBe(4);
  });
});

describe('Multi-layer selection, blueprint extraction/transform/stamping, port config, and undo/redo', () => {
  it('supports recipe & active/disabled port config + atomic undo/redo', () => {
    let hist = createHistory(createStarterBlueprint());
    const asm = hist.present.buildings.find((b) => b.type === 'DAT_Assembler')!;
    const updated = updateBuildingConfigCmd(hist.present, [asm.id], {
      recipeId: 'REC_BasicCircuit',
      disabledPorts: [0, 2, 5],
      label: '电路核心',
    });
    expect(updated.changed).toBe(true);
    hist = commitHistory(hist, updated.doc);

    const after = hist.present.buildings.find((b) => b.id === asm.id)!;
    expect(after.recipeId).toBe('REC_BasicCircuit');
    expect(after.disabledPorts).toEqual([0, 2, 5]);
    expect(after.label).toBe('电路核心');

    hist = undoHistory(hist);
    expect(hist.present.buildings.find((b) => b.id === asm.id)?.recipeId).toBe('REC_HullPlates');
    hist = redoHistory(hist);
    expect(hist.present.buildings.find((b) => b.id === asm.id)?.recipeId).toBe('REC_BasicCircuit');

    // Pipette full-attribute copy placement preserves recipe, label, disabledPorts, and rotation independently
    const sampled = hist.present.buildings.find((b) => b.id === asm.id)!;
    const cloned = placeBuildingCmd(hist.present, {
      type: sampled.type,
      x: 20,
      y: 16,
      floor: sampled.floor,
      rotation: sampled.rotation,
      recipeId: sampled.recipeId,
      label: sampled.label,
      disabledPorts: sampled.disabledPorts ? [...sampled.disabledPorts] : undefined,
      undergroundMode: sampled.undergroundMode,
    });
    expect(cloned.changed).toBe(true);
    const placedCopy = cloned.doc.buildings.find((b) => b.id === cloned.addedBuildingIds![0])!;
    expect(placedCopy.recipeId).toBe('REC_BasicCircuit');
    expect(placedCopy.label).toBe('电路核心');
    expect(placedCopy.disabledPorts).toEqual([0, 2, 5]);
    expect(placedCopy.rotation).toBe(sampled.rotation);
  });

  it('box-selects across layers according to SelectionLayerMode and stamps rotated/mirrored sub-blueprints', () => {
    const starter = createStarterBlueprint();
    const box = { minX: 0, minY: 0, maxX: 64, maxY: 32 };
    const focusOnly = boxSelectEntities(starter, box, {
      viewMode: 'building',
      focusFloor: 0,
      hideAbove: true,
      layerMode: 'focus',
    });
    const allLayers = boxSelectEntities(starter, box, {
      viewMode: 'building',
      focusFloor: 0,
      hideAbove: true,
      layerMode: 'all',
    });
    expect(allLayers.buildingIds.length).toBeGreaterThan(focusOnly.buildingIds.length);

    // Extract single refinery + belt sub-blueprint, rotate, mirror, and stamp onto empty 2x2 A
    const sub = extractSelectionAsBlueprint(starter, { moduleIds: [], buildingIds: ['bld_ref1', 'bld_b1'] }, '单元');
    expect(sub).not.toBeNull();
    const rotated = rotateBlueprint(sub!, 1);
    const mirrored = mirrorBlueprintX(rotated);

    let blank = createEmptyBlueprint();
    blank = placeModuleCmd(blank, { type: 'BPO_Station_02A', gx: 0, gy: 0, floor: 0, rotation: 0 }).doc;
    const stamped = stampBlueprintCmd(blank, mirrored, { x: 10, y: 10, floor: 0 });
    expect(stamped.changed).toBe(true);
    expect(stamped.doc.buildings.length).toBe(2);

    // Cascade delete module removes buildings inside
    const del = deleteSelectionCmd(stamped.doc, { moduleIds: [stamped.doc.modules[0].id], buildingIds: [] });
    expect(del.doc.modules.length).toBe(0);
    expect(del.doc.buildings.length).toBe(0);
  });
});

describe('Versioned JSON codec safety', () => {
  it('starter blueprint has 100% valid modules and buildings (including doorway belts and 2x2 B L1 balcony)', () => {
    const starter = createStarterBlueprint();
    expect(starter.modules.length).toBeGreaterThan(0);
    expect(starter.buildings.length).toBeGreaterThan(0);
    for (const b of starter.buildings) {
      const issue = validateBuildingPlacement(starter, b, { ignoreBuildingIds: new Set([b.id]) });
      expect(issue, `building ${b.id} (${b.type}) at (${b.x},${b.y},L${b.floor})`).toBeNull();
      if (b.recipeId) {
        expect(getRecipeDef(b.recipeId), `recipeId ${b.recipeId} on ${b.id} must exist in catalog`).toBeDefined();
      }
    }
  });

  it('round-trips starter blueprint and preserves unknown extensions without data loss', () => {
    const starter = createStarterBlueprint();
    starter.extensions = { customNote: 'keep-me' };
    const text = serializeBlueprint(starter);
    const decoded = deserializeBlueprint(text);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.doc.modules.length).toBe(starter.modules.length);
      expect(decoded.doc.buildings.length).toBe(starter.buildings.length);
      expect(decoded.doc.extensions?.customNote).toBe('keep-me');
    }
  });

  it('rejects corrupt JSON and newer formatVersion safely', () => {
    expect(deserializeBlueprint('{bad json').ok).toBe(false);
    const newer = JSON.stringify({
      format: 'station-blueprint-designer',
      formatVersion: 99,
      modules: [],
      buildings: [],
    });
    const res = deserializeBlueprint(newer);
    expect(res.ok).toBe(false);
  });

  it('validates 100% of built-in default profile blueprints (zero overlaps, zero out-of-floor, valid recipes)', () => {
    expect(DEFAULT_LIBRARY_PRESETS.length).toBeGreaterThanOrEqual(9);
    for (const preset of DEFAULT_LIBRARY_PRESETS) {
      const { doc, path } = preset;
      expect(doc.modules.length, `${path} modules`).toBeGreaterThan(0);
      for (const m of doc.modules) {
        const issue = validateModulePlacement(doc, m, new Set([m.id]));
        expect(issue, `${path} module ${m.id} (${m.type}) at (${m.gx},${m.gy},L${m.floor})`).toBeNull();
      }
      for (const b of doc.buildings) {
        const issue = validateBuildingPlacement(doc, b, { ignoreBuildingIds: new Set([b.id]) });
        expect(issue, `${path} building ${b.id} (${b.type}) at (${b.x},${b.y},L${b.floor})`).toBeNull();
        if (b.recipeId) {
          expect(getRecipeDef(b.recipeId), `${path} recipeId ${b.recipeId} on ${b.id}`).toBeDefined();
        }
      }
    }
  });

  it('enforces zero splitter leakage, zero orphan belts, clean belt connectivity, and strict symmetry on standard cells and B1/F1 hubs', () => {
    const delta = (r: number): [number, number] => (r === 0 ? [1, 0] : r === 1 ? [0, 1] : r === 2 ? [-1, 0] : [0, -1]);
    const targets = DEFAULT_LIBRARY_PRESETS.filter(
      (p) => p.path.includes('标准生产细胞/') || p.path.includes('B1-') || p.path.includes('F1-')
    );
    expect(targets.length).toBe(17);
    for (const { doc, path } of targets) {
      const cellMap = new Map<string, (typeof doc.buildings)[number]>();
      const elevPortCells = new Set<string>();
      for (const m of doc.modules) {
        const mDef = getModuleDef(m.type);
        if (!mDef) continue;
        const cx = m.gx * 16 + (mDef.sizeUnits[0] * 16) / 2;
        const cy = m.gy * 16 + (mDef.sizeUnits[1] * 16) / 2;
        for (const fl of mDef.floors) {
          for (const ep of fl.elevatorPorts ?? []) {
            elevPortCells.add(`${Math.floor(cx + ep.x)},${Math.floor(cy + ep.y)}`);
          }
        }
      }
      for (const b of doc.buildings) {
        const def = getBuildableDef(b.type)!;
        const [w, d] = b.rotation % 2 === 0 ? def.size : [def.size[1], def.size[0]];
        for (let dx = 0; dx < w; dx++) {
          for (let dy = 0; dy < d; dy++) {
            cellMap.set(`${b.x + dx},${b.y + dy}`, b);
          }
        }
      }
      // Track valid upstream feeders for every belt cell so ZERO floating/orphan belts can ever slip through!
      const fedBy = new Map<string, number>();
      const markFed = (x: number, y: number) => {
        const k = `${x},${y}`;
        fedBy.set(k, (fedBy.get(k) ?? 0) + 1);
      };
      for (const b of doc.buildings) {
        const def = getBuildableDef(b.type)!;
        if (b.type === 'DAT_ConveyorBelt3') {
          const [dx, dy] = delta(b.rotation);
          // Doorway edge entries (x=0/31 or y=0/31 entering inward) and elevator shaft port exits are valid sources
          if (
            (b.x === 0 && b.rotation === 0) ||
            (b.x === 31 && b.rotation === 2) ||
            (b.y === 0 && b.rotation === 1) ||
            (b.y === 31 && b.rotation === 3) ||
            elevPortCells.has(`${b.x - dx},${b.y - dy}`)
          ) {
            markFed(b.x, b.y);
          }
          markFed(b.x + dx, b.y + dy);
        } else if (b.type === 'DAT_Splitter_3') {
          const dis = new Set(b.disabledPorts ?? []);
          for (const [pIdx, dir] of [
            [1, (1 + b.rotation) % 4],
            [2, b.rotation % 4],
            [3, (3 + b.rotation) % 4],
          ]) {
            if (dis.has(pIdx)) continue;
            const [dx, dy] = delta(dir);
            markFed(b.x + dx, b.y + dy);
          }
        } else if (b.type === 'DAT_UndergroundBelt_3' && b.undergroundMode === 'out') {
          const [dx, dy] = delta(b.rotation);
          markFed(b.x + dx, b.y + dy);
        } else if (b.type === 'DAT_BeltBalancer_03') {
          const [dx, dy] = delta(b.rotation);
          const [w, d] = b.rotation % 2 === 0 ? def.size : [def.size[1], def.size[0]];
          for (let ox = 0; ox < w; ox++) {
            for (let oy = 0; oy < d; oy++) {
              markFed(b.x + ox + dx, b.y + oy + dy);
            }
          }
        } else if (def.kind === 'crafter' || def.kind === 'container') {
          const dis = new Set(b.disabledPorts ?? []);
          const [w, d] = b.rotation % 2 === 0 ? def.size : [def.size[1], def.size[0]];
          const cx = b.x + w / 2;
          const cy = b.y + d / 2;
          const rotVec = (vx: number, vy: number, r: number): [number, number] =>
            r === 0 ? [vx, vy] : r === 1 ? [-vy, vx] : r === 2 ? [-vx, -vy] : [vy, -vx];
          for (const p of def.ports) {
            if (dis.has(p.index)) continue;
            const [rx, ry] = rotVec(p.hx / 2, p.hy / 2, b.rotation);
            const sideDir = (['E', 'S', 'W', 'N'].indexOf(p.side) + b.rotation) % 4;
            const [sdx, sdy] = delta(sideDir);
            markFed(Math.floor(cx + rx + sdx * 0.5), Math.floor(cy + ry + sdy * 0.5));
          }
        }
      }

      for (const b of doc.buildings) {
        if (b.type === 'DAT_Splitter_3') {
          const dis = new Set(b.disabledPorts ?? []);
          for (const [pIdx, dir] of [
            [1, (1 + b.rotation) % 4],
            [2, b.rotation % 4],
            [3, (3 + b.rotation) % 4],
          ]) {
            if (dis.has(pIdx)) continue;
            const [dx, dy] = delta(dir);
            const nb = cellMap.get(`${b.x + dx},${b.y + dy}`);
            expect(nb, `${path} splitter (${b.x},${b.y}) port [${pIdx}] must not point to empty`).toBeDefined();
            if (nb?.type === 'DAT_ConveyorBelt3') {
              expect(nb.rotation, `${path} splitter (${b.x},${b.y}) port [${pIdx}] must match belt dir`).toBe(dir);
            }
          }
        }
        if (b.type === 'DAT_ConveyorBelt3') {
          expect(fedBy.get(`${b.x},${b.y}`) ?? 0, `${path} orphan/unfed belt at (${b.x},${b.y},r${b.rotation})`).toBeGreaterThan(0);
          const [dx, dy] = delta(b.rotation);
          const nx = b.x + dx;
          const ny = b.y + dy;
          if (nx < 0 || nx > 31 || ny < 0 || ny > 31 || elevPortCells.has(`${nx},${ny}`)) continue;
          const nb = cellMap.get(`${nx},${ny}`);
          expect(nb, `${path} belt (${b.x},${b.y},r${b.rotation}) must not dead-end`).toBeDefined();
          if (nb?.type === 'DAT_ConveyorBelt3') {
            expect(nb.rotation, `${path} belt (${b.x},${b.y}) head-on collision`).not.toBe((b.rotation + 2) % 4);
          }
        }
      }
      if (!path.includes('Cell-9P') && !path.includes('角落稳压母库') && !path.includes('矿石母箱') && !path.includes('翼内小总线')) {
        const keys = new Set(
          doc.buildings.map((b) => {
            const def = getBuildableDef(b.type)!;
            const [w, d] = b.rotation % 2 === 0 ? def.size : [def.size[1], def.size[0]];
            return `${b.type}:${b.x},${b.y},${w},${d}`;
          })
        );
        for (const b of doc.buildings) {
          const def = getBuildableDef(b.type)!;
          const [w, d] = b.rotation % 2 === 0 ? def.size : [def.size[1], def.size[0]];
          const my = 32 - b.y - d;
          expect(
            keys.has(`${b.type}:${b.x},${my},${w},${d}`),
            `${path} ${b.type} at (${b.x},${b.y}) missing exact mirror at (${b.x},${my})`
          ).toBe(true);
        }
      }
      if (path.includes('翼内小总线') || path.includes('电梯24口')) {
        const keys = new Set(
          doc.buildings.map((b) => {
            const def = getBuildableDef(b.type)!;
            const [w, d] = b.rotation % 2 === 0 ? def.size : [def.size[1], def.size[0]];
            return `${b.type}:${b.x},${b.y},${w},${d}`;
          })
        );
        for (const b of doc.buildings) {
          const def = getBuildableDef(b.type)!;
          const [w, d] = b.rotation % 2 === 0 ? def.size : [def.size[1], def.size[0]];
          const mx = 32 - b.x - w;
          expect(
            keys.has(`${b.type}:${mx},${b.y},${w},${d}`),
            `${path} ${b.type} at (${b.x},${b.y}) missing exact horizontal mirror at (${mx},${b.y})`
          ).toBe(true);
        }
      }
    }
  });
});

describe('Camera grab-pan orientation invariants', () => {
  it('moves camera opposite to cursor drag along both screen X and screen Y axes at yaw=0 and yaw=90°', () => {
    const rig = new CadCameraRig(16 / 9);
    const x0 = rig.targetX;
    const z0 = rig.targetZ;
    // Drag right (+dx) -> targetX decreases; drag down (+dy) -> targetZ decreases (moves North/screen-up)
    rig.panByScreenDelta(100, 100, 900);
    expect(rig.targetX).toBeLessThan(x0);
    expect(rig.targetZ).toBeLessThan(z0);

    // Rotate yaw to 90 deg (screen-right = -Z, screen-up = -X)
    rig.stepYawCardinal(1);
    for (let i = 0; i < 60; i++) rig.update(0.05, i * 50);
    const x1 = rig.targetX;
    const z1 = rig.targetZ;
    rig.panByScreenDelta(100, 100, 900);
    expect(rig.targetZ).toBeGreaterThan(z1); // opposite of screen-right (-Z) => +Z
    expect(rig.targetX).toBeLessThan(x1);    // along screen-up (-X) => -X
  });

  it('frames massive 560x528m macro stations cleanly within expanded MAX_DISTANCE', () => {
    const rig = new CadCameraRig(16 / 9);
    expect(MAX_DISTANCE).toBeGreaterThanOrEqual(1000);
    rig.fitBounds(-280, -264, 280, 264);
    expect(rig.targetX).toBe(0);
    expect(rig.targetZ).toBe(0);
    expect(rig.targetDistance).toBeGreaterThan(650);
    expect(rig.targetDistance).toBeLessThanOrEqual(MAX_DISTANCE);
  });
});

describe('Station module asymmetric alignment & corner symmetry', () => {
  it('aligns BPO_Dock_2 connectors flush onto the 16m station grid boundary and restricts floor to west 1x2 bay', () => {
    const dockDef = getModuleDef('BPO_Dock_2')!;
    const adapterDef = getModuleDef('BPO_StationAdapter_01')!;
    const adapter = { id: 'a1', type: 'BPO_StationAdapter_01', gx: 8, gy: 0, floor: 0, rotation: 0 as const };
    const dock = { id: 'd1', type: 'BPO_Dock_2', gx: 9, gy: 0, floor: 0, rotation: 0 as const };

    const aConns = getModuleWorldConnectors(adapter, adapterDef).filter((c) => c.rotation === 0);
    const dWestConns = getModuleWorldConnectors(dock, dockDef).filter((c) => c.rotation === 2);
    expect(dWestConns.length).toBe(2);
    for (const wc of dWestConns) {
      expect(wc.x).toBe(144); // Exact West wall (9 * 16m), NOT 152m!
      expect(aConns.some((ac) => ac.x === wc.x && ac.y === wc.y)).toBe(true);
    }

    // West indoor bay (x in [145..158]) is buildable; east open freighter bay (x in [165..190]) is NOT buildable
    let doc = createEmptyBlueprint();
    doc = placeModuleCmd(doc, { type: 'BPO_Dock_2', gx: 9, gy: 0, floor: 0, rotation: 0 }).doc;
    expect(isCellBuildable(doc, 148, 10, 0)).not.toBeNull();
    expect(isCellBuildable(doc, 170, 10, 0)).toBeNull();
  });

  it('keeps BPO_StationCorner_01 45-degree NE bevel symmetric across West and South faces', () => {
    let doc = createEmptyBlueprint();
    doc = placeModuleCmd(doc, { type: 'BPO_StationCorner_01', gx: 0, gy: 0, floor: 0, rotation: 0 }).doc;
    // Center (8,8) is inside, SW (2,13) is inside, NE (13,2) is outside the 45° panoramic bevel
    expect(isCellBuildable(doc, 8, 8, 0)).not.toBeNull();
    expect(isCellBuildable(doc, 2, 13, 0)).not.toBeNull();
    expect(isCellBuildable(doc, 13, 2, 0)).toBeNull();
    // Exact 45° mirror symmetry across (lx, ly) <-> (-ly, -lx): cell (cx, cy) <-> (15-cy, 15-cx)
    for (let cx = 0; cx < 16; cx++) {
      for (let cy = 0; cy < 16; cy++) {
        const a = isCellBuildable(doc, cx, cy, 0) !== null;
        const b = isCellBuildable(doc, 15 - cy, 15 - cx, 0) !== null;
        expect(a, `corner symmetry (${cx},${cy}) vs (${15 - cy},${15 - cx})`).toBe(b);
      }
    }
  });

  it('supports Splitter output port toggles (never fixed input), Balancer priority/filter (never port disable), Container filters, and mirror remapping', () => {
    expect(getBuildableDef('DAT_Splitter')?.configurablePorts).toBe(true);
    expect(getBuildableDef('DAT_BeltBalancer_01')?.configurablePorts).toBe(false);

    let doc = createEmptyBlueprint();
    doc = placeModuleCmd(doc, { type: 'BPO_Station_01', gx: 0, gy: 0, floor: 0, rotation: 0 }).doc;
    const sp = placeBuildingCmd(doc, { type: 'DAT_Splitter', x: 5, y: 5, floor: 0, rotation: 0 });
    doc = sp.doc;
    const spId = sp.addedBuildingIds![0];
    const bal = placeBuildingCmd(doc, { type: 'DAT_BeltBalancer_01', x: 8, y: 5, floor: 0, rotation: 0 });
    doc = bal.doc;
    const balId = bal.addedBuildingIds![0];
    const box = placeBuildingCmd(doc, { type: 'DAT_Container', x: 10, y: 5, floor: 0, rotation: 0 });
    doc = box.doc;
    const boxId = box.addedBuildingIds![0];

    // Attempting to disable Splitter's fixed input port 0 or any Balancer port is strictly stripped!
    doc = updateBuildingConfigCmd(doc, [spId], {
      disabledPorts: [0, 1], // 0 is fixed always-on input -> stripped; 1 (S output) kept!
      priorityOut: 3, // N output prioritized
      portFilters: { 2: 'ITEM_BasicCircuit' },
    }).doc;
    doc = updateBuildingConfigCmd(doc, [balId], {
      disabledPorts: [0, 2], // Balancer lanes are fixed always-on -> stripped completely!
      priorityIn: 0, // W-S input prioritized
      priorityOut: 3, // E-N output prioritized
      portFilters: { 2: 'ITEM_TitaniumPlates' },
    }).doc;
    doc = updateBuildingConfigCmd(doc, [boxId], {
      filterItems: ['ITEM_BasicCircuit', 'ITEM_TitaniumPlates'],
    }).doc;

    // JSON round-trip preserves valid configs and guarantees no illegal disabledPorts exist
    const decoded = deserializeBlueprint(serializeBlueprint(doc));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const spRt = decoded.doc.buildings.find((b) => b.id === spId)!;
    const balRt = decoded.doc.buildings.find((b) => b.id === balId)!;
    const boxRt = decoded.doc.buildings.find((b) => b.id === boxId)!;
    expect(spRt.disabledPorts).toEqual([1]);
    expect(balRt.disabledPorts).toBeUndefined();
    expect(spRt.priorityOut).toBe(3);
    expect(spRt.portFilters).toEqual({ 2: 'ITEM_BasicCircuit' });
    expect(balRt.priorityIn).toBe(0);
    expect(balRt.priorityOut).toBe(3);
    expect(balRt.portFilters).toEqual({ 2: 'ITEM_TitaniumPlates' });
    expect(boxRt.filterItems).toEqual(['ITEM_BasicCircuit', 'ITEM_TitaniumPlates']);

    // Horizontal mirror across X flips rotation 0 -> 2 and remaps S<->N on Splitter (1<->3) and lanes on Balancer (0<->1, 2<->3)!
    const mirrored = mirrorBlueprintX(decoded.doc);
    const spM = mirrored.buildings.find((b) => b.id === spId)!;
    const balM = mirrored.buildings.find((b) => b.id === balId)!;
    expect(spM.rotation).toBe(2);
    expect(spM.disabledPorts).toEqual([3]);
    expect(spM.priorityOut).toBe(1);
    expect(spM.portFilters).toEqual({ 2: 'ITEM_BasicCircuit' });
    expect(balM.rotation).toBe(2);
    expect(balM.priorityIn).toBe(1);
    expect(balM.priorityOut).toBe(2);
    expect(balM.portFilters).toEqual({ 3: 'ITEM_TitaniumPlates' });
  });
});

describe('General-purpose production-line simulation, flow rates, and zero-anomaly audit', () => {
  it('verifies 0 simulation errors, strict symmetries, and exact flow rates across all 17 Star-Citadel cells & B1/F1 hubs', () => {
    const targets = DEFAULT_LIBRARY_PRESETS.filter(
      (p) => p.path.includes('标准生产细胞/') || p.path.includes('B1-') || p.path.includes('F1-')
    );
    expect(targets.length).toBe(17);
    for (const { doc, path } of targets) {
      const report = simulateBlueprint(doc);
      expect(
        report.issues.filter((i) => i.severity === 'error'),
        `${path} simulation errors: ${report.issues.map((i) => `${i.code}@(${i.x},${i.y}): ${i.message}`).join(' | ')}`
      ).toEqual([]);
      expect(report.passed, `${path} must pass simulation`).toBe(true);
    }

    // Verify B1 2:1 Hydrogen->Deuterium Fuel cell runs at 100% efficiency, 0 errors, exact 0.667/s Deuterium output!
    const b1Fuel = DEFAULT_LIBRARY_PRESETS.find((p) => p.path.includes('氢氘燃料直连舱'))!.doc;
    const rFuel = simulateBlueprint(b1Fuel);
    expect(rFuel.errorCount).toBe(0);
    expect(rFuel.anomalyWarnCount).toBe(0);
    expect(rFuel.avgEfficiency).toBe(1);
    expect(rFuel.netInputs.map((i) => i.itemId)).toEqual(['ITEM_WaterIce']);
    expect(rFuel.netOutputs.find((o) => o.itemId === 'ITEM_EnrichedFuel')?.ratePerSec).toBeCloseTo(2 / 3, 2);

    // Verify 2x2 Elevator 24-Port template connects all 12 elevator entries + 12 elevator exits with 0 errors!
    const elev24 = DEFAULT_LIBRARY_PRESETS.find((p) => p.path.includes('电梯24口'))!.doc;
    const rElev = simulateBlueprint(elev24);
    expect(rElev.errorCount).toBe(0);
    expect(rElev.anomalyWarnCount).toBe(0);
    expect(rElev.externalInputs.filter((e) => e.sourceKind === 'elevator').length).toBe(12);
    expect(rElev.externalOutputs.filter((e) => e.sinkKind === 'elevator').length).toBe(12);

    // Verify exact Cell-3 full dual-Mk.3 output (6.00 items/s Titanium Plates, 100% efficiency)
    const cell3 = DEFAULT_LIBRARY_PRESETS.find((p) => p.path.includes('Cell-3'))!.doc;
    const r3 = simulateBlueprint(cell3);
    expect(r3.avgEfficiency).toBe(1);
    expect(r3.netOutputs.find((o) => o.itemId === 'ITEM_TitaniumPlates')?.ratePerSec).toBeCloseTo(6.0, 2);

    // Verify Cell-9Q runs with 0 errors, 0 anomaly warnings, 100% efficiency, and surfaces yellow raw-input entry warnings!
    const cell9q = DEFAULT_LIBRARY_PRESETS.find((p) => p.path.includes('Cell-9Q'))!.doc;
    const r9q = simulateBlueprint(cell9q);
    expect(r9q.errorCount).toBe(0);
    expect(r9q.anomalyWarnCount).toBe(0);
    expect(r9q.externalInputs.length).toBeGreaterThan(0);
    expect(r9q.issues.some((i) => i.code === 'external-input-needed' && i.severity === 'warn')).toBe(true);
    expect(r9q.avgEfficiency).toBe(1);
    expect(r9q.configuredMachineCount).toBe(6);

    // Verify B1 2:1 Ore Enricher with Priority Balancers: 0 errors, 0 anomaly warnings, 100% efficiency, Protomatter-only net input!
    const b1Ore = DEFAULT_LIBRARY_PRESETS.find((p) => p.path.includes('B1-矿石2比1'))!.doc;
    const rOre = simulateBlueprint(b1Ore);
    expect(rOre.errorCount).toBe(0);
    expect(rOre.anomalyWarnCount).toBe(0);
    expect(rOre.externalInputs.some((e) => e.itemId === 'ITEM_Protomatter')).toBe(true);
    expect(rOre.avgEfficiency).toBe(1);
    expect(rOre.netInputs.map((i) => i.itemId)).toEqual(['ITEM_Protomatter']);
    expect(rOre.netOutputs.find((o) => o.itemId === 'ITEM_EnrichedTitaniumOre')?.ratePerSec).toBeCloseTo(4 / 3, 2);

    // Verify B1 Corner Vault has 100% bit-for-bit anti-diagonal mirror symmetry: (x, y, w, d) <-> (32-y-d, 32-x-w, d, w)!
    const vault = DEFAULT_LIBRARY_PRESETS.find((p) => p.path.includes('角落稳压母库'))!.doc;
    const vaultKeys = new Set(
      vault.buildings.map((b) => {
        const def = getBuildableDef(b.type)!;
        const [w, d] = b.rotation % 2 === 0 ? def.size : [def.size[1], def.size[0]];
        return `${b.type}:${b.x},${b.y},${w},${d}`;
      })
    );
    for (const b of vault.buildings) {
      const def = getBuildableDef(b.type)!;
      const [w, d] = b.rotation % 2 === 0 ? def.size : [def.size[1], def.size[0]];
      const mx = 32 - b.y - d;
      const my = 32 - b.x - w;
      expect(
        vaultKeys.has(`${b.type}:${mx},${my},${d},${w}`),
        `Corner Vault ${b.type} at (${b.x},${b.y}) missing exact anti-diagonal mirror at (${mx},${my})`
      ).toBe(true);
    }
  });

  it('catches isolated orphan belts while marking open-line head/tail yellow without false red errors', () => {
    let doc = createEmptyBlueprint();
    doc = placeModuleCmd(doc, { type: 'BPO_Station_03', gx: 0, gy: 0, floor: 0, rotation: 0 }).doc;
    // 1. Completely isolated 1-tile belt -> RED orphan-belt
    doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt3', x: 10, y: 10, floor: 0, rotation: 0 }).doc;
    const repIsolated = simulateBlueprint(doc);
    expect(repIsolated.passed).toBe(false);
    expect(repIsolated.issues.some((i) => i.code === 'orphan-belt' && i.severity === 'error' && i.x === 10 && i.y === 10)).toBe(true);

    // 2. Extend into a 2-tile open line -> ZERO red errors; head (10,10) = yellow input, tail (11,10) = yellow output!
    doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt3', x: 11, y: 10, floor: 0, rotation: 0 }).doc;
    const repLine = simulateBlueprint(doc);
    expect(repLine.passed).toBe(true);
    expect(repLine.errorCount).toBe(0);
    expect(repLine.issues.some((i) => i.code === 'external-input-needed' && i.severity === 'warn' && i.x === 10 && i.y === 10)).toBe(true);
    expect(repLine.issues.some((i) => i.code === 'blueprint-output' && i.severity === 'warn' && i.x === 11 && i.y === 10)).toBe(true);
  });

  it('verifies ALL new real-game simulation rules, braided encoded undergrounds, and zero west-cabin errors on Sim-Debug blueprint', () => {
    const preset = DEFAULT_LIBRARY_PRESETS.find((p) => p.path.includes('Sim-Debug-全情况诊断台'));
    expect(preset, 'Sim-Debug diagnostic blueprint must be present in default library').toBeDefined();
    const rep = simulateBlueprint(preset!.doc);

    // 1. West Cabin (x < 32): ZERO red errors across Zones A-E, braided undergrounds, and unfed 2-stage template!
    const westErrors = rep.issues.filter((i) => i.severity === 'error' && i.x < 32);
    expect(westErrors).toEqual([]);

    // Braided parallel same-line undergrounds on y=28 pair cleanly via explicit undergroundPartnerId: (4->10) & (6->8)!
    const y28Links = computeUndergroundLinks(preset!.doc).filter((l) => l.y1 === 28.5);
    expect(y28Links.length).toBe(2);
    expect(y28Links.some((l) => l.x1 === 4.5 && l.x2 === 10.5)).toBe(true);
    expect(y28Links.some((l) => l.x1 === 6.5 && l.x2 === 8.5)).toBe(true);

    // Unfed 2-stage template (Refinery (13,26) -> Assembler (17,26) -> Tail (22,27)):
    // ONLY Refinery head gets YELLOW external-input-needed; middle Assembler has ZERO errors and tail emits LightweightFrame!
    expect(
      rep.issues.some((i) => i.code === 'external-input-needed' && i.severity === 'warn' && i.x === 13 && i.y === 26)
    ).toBe(true);
    expect(rep.issues.some((i) => i.x === 17 && i.y === 26 && i.severity === 'error')).toBe(false);
    const d2Tail = rep.externalOutputs.find((o) => o.x === 22 && o.y === 27);
    expect(d2Tail?.items.some((it) => it.itemId === 'ITEM_LightweightFrame')).toBe(true);

    // Power verification: Solar Mk.1 (12, min 20%=2.4) + Reactor (48) = 60 MW max / 50.4 MW min gen
    expect(rep.power.solarGenMW).toBe(12);
    expect(rep.power.reactorGenMW).toBe(48);
    expect(rep.power.maxGenMW).toBe(60);
    expect(rep.power.minGenMW).toBe(50.4);
    expect(rep.issues.some((i) => i.code === 'power-deficit' && i.severity === 'warn')).toBe(true);

    // Deterministic upstream-surplus balance hint on Zone B (2x Refinery 0.67/s > 1x Assembler 0.50/s -> ~75% backpressure!)
    const zoneBHint = rep.balanceHints.find((h) => h.x === 11 && h.y === 8 && h.itemId === 'ITEM_TitaniumPlates');
    expect(zoneBHint, 'Zone B Assembler (11,8) should report deterministic ~75% upstream surplus hint').toBeDefined();
    expect(zoneBHint!.estDutyRatio).toBeCloseTo(0.75, 2);

    // 2. East Cabin YELLOW rules:
    //    - F3a: Belt into disabled port (44,3) -> YELLOW 'disabled-port-input' (still feeds Refinery!)
    //    - F6: Open splitter port (41,8) -> ZERO red splitter-leak!
    //    - F7: Mixed belt -> YELLOW 'mixed-item-belt' ONLY at exact merge origin (39,13), NOT on downstream (40,13)!
    //    - F8: Unwired Assembler input (46,11) -> YELLOW 'external-input-needed', ZERO red error!
    expect(
      rep.issues.some((i) => i.code === 'disabled-port-input' && i.severity === 'warn' && i.x === 44 && i.y === 3)
    ).toBe(true);
    expect(rep.issues.some((i) => i.code === 'splitter-leak' && i.x === 41 && i.y === 8)).toBe(false);
    expect(
      rep.issues.some((i) => i.code === 'mixed-item-belt' && i.severity === 'warn' && i.x === 39 && i.y === 13)
    ).toBe(true);
    expect(rep.issues.some((i) => i.code === 'mixed-item-belt' && i.x === 40 && i.y === 13)).toBe(false);
    expect(
      rep.issues.some((i) => i.code === 'external-input-needed' && i.severity === 'warn' && i.x === 46 && i.y === 11)
    ).toBe(true);
    expect(rep.issues.some((i) => i.severity === 'error' && i.x === 46 && i.y === 11)).toBe(false);

    // 3. East Cabin RED mid-line faults MUST fire at their exact coordinates!
    const expectedEastFaults: Array<[string, number, number]> = [
      ['orphan-belt', 35, 3],
      ['head-on-belt', 39, 3],
      ['port-mismatch', 44, 2],
      ['dead-end-belt', 61, 1],
      ['unpaired-underground', 35, 8],
      ['machine-wrong-item', 49, 18],
      ['machine-blocked-output', 56, 12],
      ['belt-overload', 49, 26],
      ['port-mismatch', 60, 21],
    ];
    for (const [code, x, y] of expectedEastFaults) {
      expect(
        rep.issues.some((i) => i.code === code && i.severity === 'error' && i.x === x && i.y === y),
        `Expected RED ${code} at (${x},${y})`
      ).toBe(true);
    }

    // 4. Verify braided encoded undergrounds survive extract -> rotate -> stamp intact!
    const braidedIds = preset!.doc.buildings.filter((b) => b.y === 28 && b.x >= 4 && b.x <= 10).map((b) => b.id);
    const sub = extractSelectionAsBlueprint(preset!.doc, { moduleIds: [], buildingIds: braidedIds }, 'braided')!;
    const rotSub = rotateBlueprint(sub, 1);
    let targetDoc = createEmptyBlueprint();
    targetDoc = placeModuleCmd(targetDoc, { type: 'BPO_Station_02A', gx: 0, gy: 0, floor: 0, rotation: 0 }).doc;
    const stamped = stampBlueprintCmd(targetDoc, rotSub, { x: 10, y: 10, floor: 0 });
    expect(stamped.changed).toBe(true);
    const stampedLinks = computeUndergroundLinks(stamped.doc);
    expect(stampedLinks.length).toBe(2);
    // Straddling spans: length 6 (4->10) and length 2 (6->8) preserved after 90-deg rotation & stamp!
    const spans = stampedLinks.map((l) => Math.abs(l.x2 - l.x1) + Math.abs(l.y2 - l.y1)).sort((a, z) => a - z);
    expect(spans).toEqual([2, 6]);
  });

  it('computes binary-verified power draw, max generation (solar + reactor), output-bottleneck efficiency, and open-belt yellow raw-input warnings at arbitrary coordinates', () => {
    // 1. Arbitrary offset module (gx=3, gy=-2 => x in [48..64], y in [-32..-16]) — ZERO 32x32 origin assumption!
    let doc = createEmptyBlueprint();
    doc = placeModuleCmd(doc, { type: 'BPO_Station_02A', gx: 3, gy: -2, floor: 0, rotation: 0 }).doc;
    doc = placeModuleCmd(doc, { type: 'BPO_SolarPanelBlock', gx: 2, gy: -2, floor: 0, rotation: 0 }).doc; // 12 MW max
    doc = placeModuleCmd(doc, { type: 'BPO_SolarPanelBlock_02', gx: 2, gy: -1, floor: 0, rotation: 0 }).doc; // 48 MW max
    doc = placeModuleCmd(doc, { type: 'BPO_DeepSpaceObservatory', gx: 5, gy: -2, floor: 0, rotation: 0 }).doc; // 96 MW draw

    // Place Supercomputer (18 MW!) + QuantumSciLab (12 MW) + Reactor (48 MW gen) + Refinery (4.5 MW) with open feed belt
    const sc = placeBuildingCmd(doc, { type: 'DAT_Supercomputer', x: 52, y: -28, floor: 0, rotation: 0 });
    doc = sc.doc;
    const lab = placeBuildingCmd(doc, { type: 'DAT_QuantumSciLab', x: 60, y: -28, floor: 0, rotation: 0 });
    doc = lab.doc;
    const rct = placeBuildingCmd(doc, { type: 'DAT_ReactorMachine', x: 60, y: -12, floor: 0, rotation: 0 });
    doc = rct.doc;

    // Refinery at (52, -16) with recipe REC_TitaniumPlates (input: TitaniumOre 1/2s = 0.5/s, output: TitaniumPlates 0.5/s)
    const refRes = placeBuildingCmd(doc, {
      type: 'DAT_Refinery',
      x: 52,
      y: -16,
      floor: 0,
      rotation: 0,
      recipeId: 'REC_TitaniumPlates',
    });
    doc = refRes.doc;
    // Open feed belt entering West port of Refinery (51, -15) -> should emit YELLOW 'external-input-needed' (NOT red orphan-belt!)
    doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt', x: 51, y: -15, floor: 0, rotation: 0 }).doc;

    // Case A: Refinery has NO output belt -> steady-state efficiency MUST be 0% (output bottleneck!)
    const repBlocked = simulateBlueprint(doc);
    expect(repBlocked.avgEfficiency).toBe(0);
    expect(repBlocked.issues.some((i) => i.code === 'external-input-needed' && i.severity === 'warn' && i.x === 51 && i.y === -15)).toBe(true);
    expect(repBlocked.issues.some((i) => i.code === 'orphan-belt' && i.x === 51 && i.y === -15)).toBe(false);

    // Verify exact binary power numbers:
    // Max gen = Solar1 (12) + Solar2 (48) + Reactor (48) = 108 MW
    // Peak draw = Observatory (96) + Supercomputer (18) + QuantumLab (12) + Refinery (4.5) = 130.5 MW -> deficit 22.5 MW!
    expect(repBlocked.power.solarGenMW).toBe(60);
    expect(repBlocked.power.reactorGenMW).toBe(48);
    expect(repBlocked.power.maxGenMW).toBe(108);
    expect(repBlocked.power.peakDrawMW).toBe(130.5);
    expect(repBlocked.power.netBalanceMW).toBe(-22.5);
    expect(repBlocked.issues.some((i) => i.code === 'power-deficit' && i.severity === 'warn')).toBe(true);

    // Case B: Connect output belt from Refinery (55, -15) to Container (56, -16) + Solar Mk.3 (+288 MW) + Turret (6 MW peak, 0 peacetime active)
    doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt', x: 55, y: -15, floor: 0, rotation: 0 }).doc;
    doc = placeBuildingCmd(doc, { type: 'DAT_Container', x: 56, y: -16, floor: 0, rotation: 0 }).doc;
    doc = placeModuleCmd(doc, { type: 'BPO_SolarPanelBlock_03', gx: 1, gy: 0, floor: 0, rotation: 0 }).doc; // +288 MW max
    doc = placeModuleCmd(doc, { type: 'BPO_StationTurretBlock_01', gx: 2, gy: -3, floor: 0, rotation: 0 }).doc; // 6 MW combat peak, 0 peacetime

    const repRun = simulateBlueprint(doc);
    expect(repRun.errorCount).toBe(0);
    expect(repRun.avgEfficiency).toBe(1);
    expect(repRun.power.maxGenMW).toBe(396);
    expect(repRun.power.minGenMW).toBe(117.6); // 48 reactor + 348 * 0.2 solar
    expect(repRun.power.intermittentPeakMW).toBe(6);
    expect(repRun.power.peakDrawMW).toBe(136.5); // 130.5 + 6 turret peak
    expect(repRun.power.netBalanceMW).toBe(259.5);
    expect(repRun.issues.some((i) => i.code === 'power-deficit')).toBe(false);
    // Active power = Observatory (96) + Refinery active (4.5 * 1.0) = 100.5 MW (Turret = 0 peacetime active!)
    expect(repRun.power.activeDrawMW).toBe(100.5);
    // Terminal storage Container counts cleanly in netOutputs!
    expect(repRun.netOutputs.find((o) => o.itemId === 'ITEM_TitaniumPlates')?.ratePerSec).toBeCloseTo(1 / 3, 2);
  });
});
