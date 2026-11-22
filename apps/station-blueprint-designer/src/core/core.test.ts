import { describe, expect, it } from 'vitest';
import { buildPlannedBeltPath, extendBeltStroke, selectConnectedBeltChain } from './belt-router';
import { CATALOG, getBuildableDef, getModuleDef, getRecipesForCrafter } from './catalog';
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
import { computeUndergroundLinks, isCellBuildable, validateBuildingPlacement } from './geometry';
import { BUILDING_GROUPS, cycleVariantInGroup, getShortLabel, STATION_GROUPS } from './groups';

describe('Build 26639889 catalog verification', () => {
  it('includes all extracted station modules, buildables, and recipes with binary-verified dimensions', () => {
    expect(CATALOG.game.buildId).toBe('26639889');
    expect(CATALOG.stationModules.length).toBeGreaterThanOrEqual(24);
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
    expect(hist.present.buildings.find((b) => b.id === asm.id)?.recipeId).toBe('REC_HullPlate');
    hist = redoHistory(hist);
    expect(hist.present.buildings.find((b) => b.id === asm.id)?.recipeId).toBe('REC_BasicCircuit');
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
});
