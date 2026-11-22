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
import { computeUndergroundLinks, isCellBuildable, validateBuildingPlacement, validateModulePlacement } from './geometry';
import { BUILDING_GROUPS, cycleVariantInGroup, getShortLabel, STATION_GROUPS } from './groups';
import { DEFAULT_LIBRARY_PRESETS } from './presets';
import { CadCameraRig } from '../renderer/camera-rig';

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

  it('enforces zero splitter leakage, clean belt connectivity, and strict vertical mirror symmetry on standard cells and 8x8 interchange', () => {
    const delta = (r: number): [number, number] => (r === 0 ? [1, 0] : r === 1 ? [0, 1] : r === 2 ? [-1, 0] : [0, -1]);
    const targets = DEFAULT_LIBRARY_PRESETS.filter(
      (p) => p.path.includes('标准生产细胞/') || p.path.includes('8x8对称井字立交')
    );
    expect(targets.length).toBe(11);
    for (const { doc, path } of targets) {
      const cellMap = new Map<string, (typeof doc.buildings)[number]>();
      for (const b of doc.buildings) {
        const def = getBuildableDef(b.type)!;
        const [w, d] = b.rotation % 2 === 0 ? def.size : [def.size[1], def.size[0]];
        for (let dx = 0; dx < w; dx++) {
          for (let dy = 0; dy < d; dy++) {
            cellMap.set(`${b.x + dx},${b.y + dy}`, b);
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
          const [dx, dy] = delta(b.rotation);
          const nx = b.x + dx;
          const ny = b.y + dy;
          if (nx < 0 || nx > 31 || ny < 0 || ny > 31) continue;
          const nb = cellMap.get(`${nx},${ny}`);
          expect(nb, `${path} belt (${b.x},${b.y},r${b.rotation}) must not dead-end`).toBeDefined();
          if (nb?.type === 'DAT_ConveyorBelt3') {
            expect(nb.rotation, `${path} belt (${b.x},${b.y}) head-on collision`).not.toBe((b.rotation + 2) % 4);
          }
        }
      }
      if (!path.includes('Cell-9P')) {
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
});
