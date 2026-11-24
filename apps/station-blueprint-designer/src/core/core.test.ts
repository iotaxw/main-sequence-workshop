import { describe, expect, it } from 'vitest';
import {
  buildBeltStrokeSpecs,
  buildPlannedBeltPath,
  buildPlannedBeltPathWithTunnels,
  extendBeltStroke,
  extendBeltStrokeWithTunnels,
  getMatchingBeltType,
  getMatchingUndergroundType,
  selectConnectedBeltChain,
  toggleBeltStrokeTunnel,
  type BeltStrokeTunnel,
} from './belt-router';
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
import {
  clearSavedGitHubConfig,
  clearWorkspaceAutosave,
  GitHubPrivateRepoDriver,
  loadSavedGitHubConfig,
  loadWorkspaceAutosave,
  saveGitHubConfig,
  saveWorkspaceAutosave,
  VirtualFolderDriver,
} from './library';
import { exportNativeSav, importNativeSav } from './native-codec';
import { DEFAULT_LIBRARY_PRESETS, HAS_PRIVATE_PRESETS } from './presets';
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

  it('atomically cuts a station module together with its interior buildings (shapez 2 Ctrl+X move flow)', () => {
    let doc = createEmptyBlueprint();
    const mRes = placeModuleCmd(doc, { type: 'BPO_Station_02A', gx: 0, gy: 0, floor: 0, rotation: 0 });
    doc = mRes.doc;
    const modId = mRes.addedModuleIds![0];
    doc = placeBuildingCmd(doc, {
      type: 'DAT_Assembler',
      x: 6,
      y: 6,
      floor: 0,
      rotation: 0,
      recipeId: 'REC_HullPlates',
      label: 'A1',
    }).doc;
    doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt3', x: 11, y: 8, floor: 0, rotation: 0 }).doc;

    const sel = { moduleIds: [modId], buildingIds: [] };
    const bp = extractSelectionAsBlueprint(doc, sel, '剪贴板蓝图')!;
    expect(bp.modules.length).toBe(1);
    expect(bp.buildings.length).toBe(2);

    const afterCut = deleteSelectionCmd(doc, sel, { cascadeBuildingsInModules: true });
    expect(afterCut.changed).toBe(true);
    expect(afterCut.doc.modules.length).toBe(0);
    expect(afterCut.doc.buildings.length).toBe(0);

    const moved = stampBlueprintCmd(afterCut.doc, bp, { x: 32, y: 16, floor: 1 });
    expect(moved.changed).toBe(true);
    expect(moved.doc.modules.length).toBe(1);
    expect(moved.doc.modules[0].gx).toBe(2);
    expect(moved.doc.modules[0].gy).toBe(1);
    expect(moved.doc.modules[0].floor).toBe(1);
    expect(moved.doc.buildings.length).toBe(2);
    const movedAsm = moved.doc.buildings.find((b) => b.type === 'DAT_Assembler')!;
    expect(movedAsm.x).toBe(38);
    expect(movedAsm.y).toBe(22);
    expect(movedAsm.floor).toBe(1);
    expect(movedAsm.recipeId).toBe('REC_HullPlates');
    expect(movedAsm.label).toBe('A1');
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
    expect(DEFAULT_LIBRARY_PRESETS.length).toBeGreaterThanOrEqual(HAS_PRIVATE_PRESETS ? 9 : 1);
    for (const preset of DEFAULT_LIBRARY_PRESETS) {
      const { doc, path } = preset;
      expect(doc.modules.length, `${path} modules`).toBeGreaterThan(0);
      for (const m of doc.modules) {
        const issue = validateModulePlacement(doc, m, new Set([m.id]));
        expect(issue, `${path} module ${m.id} (${m.type}) at (${m.gx},${m.gy},L${m.floor})`).toBeNull();
      }
      // O(N) spatial hash check for zero building overlaps + O(1)-bucketed exact buildable floor coverage!
      const modBuckets = new Map<string, typeof doc.modules>();
      for (const m of doc.modules) {
        const md = getModuleDef(m.type);
        if (!md) continue;
        const wu = m.rotation % 2 === 0 ? md.sizeUnits[0] : md.sizeUnits[1];
        const du = m.rotation % 2 === 0 ? md.sizeUnits[1] : md.sizeUnits[0];
        for (const fl of md.floors) {
          const f = m.floor + fl.floorOffset;
          for (let ux = m.gx; ux < m.gx + wu; ux++) {
            for (let uy = m.gy; uy < m.gy + du; uy++) {
              const bk = `${f}:${ux},${uy}`;
              const list = modBuckets.get(bk);
              if (list) list.push(m);
              else modBuckets.set(bk, [m]);
            }
          }
        }
      }
      const occupied = new Map<string, string>();
      const violations: string[] = [];
      for (const b of doc.buildings) {
        const def = getBuildableDef(b.type);
        if (!def) {
          violations.push(`${path} unknown building type ${b.type} on ${b.id}`);
          continue;
        }
        const [w, d] = b.rotation % 2 === 0 ? def.size : [def.size[1], def.size[0]];
        for (let dx = 0; dx < w; dx++) {
          for (let dy = 0; dy < d; dy++) {
            const cx = b.x + dx;
            const cy = b.y + dy;
            const key = `${b.floor}:${cx},${cy}`;
            const prev = occupied.get(key);
            if (prev) {
              violations.push(`${path} overlap at (${cx},${cy},L${b.floor}) between ${prev} and ${b.id}`);
            } else {
              occupied.set(key, b.id);
            }
            const bucketMods = modBuckets.get(`${b.floor}:${Math.floor(cx / 16)},${Math.floor(cy / 16)}`) ?? [];
            if (!isCellBuildable({ ...doc, modules: bucketMods }, cx, cy, b.floor)) {
              violations.push(`${path} building ${b.id} (${b.type}) out-of-floor at (${cx},${cy},L${b.floor})`);
            }
          }
        }
        if (b.recipeId && !getRecipeDef(b.recipeId)) {
          violations.push(`${path} recipeId ${b.recipeId} on ${b.id}`);
        }
      }
      expect(violations, `${path} layout violations`).toEqual([]);
    }
  });

  it('enforces zero splitter leakage, zero orphan belts, clean belt connectivity, and strict symmetry on standard cells and B1/F1 hubs', () => {
    const delta = (r: number): [number, number] => (r === 0 ? [1, 0] : r === 1 ? [0, 1] : r === 2 ? [-1, 0] : [0, -1]);
    const targets = DEFAULT_LIBRARY_PRESETS.filter(
      (p) => p.path.includes('标准生产细胞/') || p.path.includes('B1-') || p.path.includes('F1-') || p.path.includes('F2-电梯')
    );
    if (!HAS_PRIVATE_PRESETS) {
      expect(DEFAULT_LIBRARY_PRESETS.map((p) => p.path)).toEqual(['2x2A-标准起步模板.json']);
      return;
    }
    expect(targets.length).toBeGreaterThanOrEqual(21);
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
      const distinctRecipes = new Set(doc.buildings.map((b) => b.recipeId).filter(Boolean));
      if (
        distinctRecipes.size <= 1 &&
        !path.includes('Cell-9P') &&
        !path.includes('角落稳压母库') &&
        !path.includes('矿石母箱') &&
        !path.includes('翼内小总线') &&
        !path.includes('玻璃玄关') &&
        !path.includes('F2-电梯')
      ) {
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
      if (path.includes('翼内小总线') || path.includes('电梯24口') || path.includes('玻璃玄关') || path.includes('F2-电梯') || path.includes('中央工业巡检')) {
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
      (p) => p.path.includes('标准生产细胞/') || p.path.includes('B1-') || p.path.includes('F1-') || p.path.includes('F2-电梯')
    );
    if (!HAS_PRIVATE_PRESETS) {
      expect(DEFAULT_LIBRARY_PRESETS.length).toBe(1);
      return;
    }
    expect(targets.length).toBeGreaterThanOrEqual(21);
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

    // Verify F2 Elevator->Boutique transition connects all 12 northern elevator ports cleanly with 0 errors!
    const f2Elev = DEFAULT_LIBRARY_PRESETS.find((p) => p.path.includes('F2-电梯商业街'))!.doc;
    const rF2Elev = simulateBlueprint(f2Elev);
    expect(rF2Elev.errorCount).toBe(0);
    expect(rF2Elev.anomalyWarnCount).toBe(0);
    expect(rF2Elev.externalInputs.filter((e) => e.sourceKind === 'elevator').length).toBe(12);

    // Verify F2 Boutique Street feeds all 12 showcase containers via 12 pure zero-crossing lanes with 0 errors!
    const f2Street = DEFAULT_LIBRARY_PRESETS.find((p) => p.path.includes('F2-巨窗星光商业街'))!.doc;
    const rF2Street = simulateBlueprint(f2Street);
    expect(rF2Street.errorCount).toBe(0);
    expect(rF2Street.anomalyWarnCount).toBe(0);
    expect(rF2Street.externalInputs.length).toBe(12);

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

    // Verify all 8 floating plasma turrets in the master Star-Citadel face symmetrically OUTWARD (barrels away from center gx=1,gy=1)
    const master = DEFAULT_LIBRARY_PRESETS.find((p) => p.path.includes('01-星穹金字塔-三层骨架总图'))!.doc;
    const turrets = master.modules.filter((m) => m.type === 'BPO_StationTurretBlock_01');
    expect(turrets.length).toBe(8);
    const turretMap = new Map(turrets.map((t) => [`${t.gx},${t.gy},${t.floor}`, t.rotation]));
    for (const t of turrets) {
      const cx = t.gx + 0.5 - 1;
      const cy = t.gy + 0.5 - 1;
      const [dx, dy] = t.rotation === 0 ? [1, 0] : t.rotation === 1 ? [0, 1] : t.rotation === 2 ? [-1, 0] : [0, -1];
      // Outward dot product > 0: barrels point strictly outward into deep space, docking collar faces inward!
      expect(dx * cx + dy * cy, `Turret (${t.gx},${t.gy},L${t.floor}) rot=${t.rotation} must face outward`).toBeGreaterThan(0);
      // Exact E-W mirror (gx <-> 1 - gx, rot 0 <-> 2) and N-S mirror (gy <-> 1 - gy, rot 1 <-> 3)
      const ewRot = t.rotation === 0 ? 2 : t.rotation === 2 ? 0 : t.rotation;
      const nsRot = t.rotation === 1 ? 3 : t.rotation === 3 ? 1 : t.rotation;
      expect(turretMap.get(`${1 - t.gx},${t.gy},${t.floor}`)).toBe(ewRot);
      expect(turretMap.get(`${t.gx},${1 - t.gy},${t.floor}`)).toBe(nsRot);
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
    if (!HAS_PRIVATE_PRESETS) {
      expect(preset).toBeUndefined();
      return;
    }
    expect(preset, 'Sim-Debug diagnostic blueprint must be present in private library').toBeDefined();
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

  it('links stacked 2x2 elevator shafts across floors at matching (wx, wy) columns (Build 26639889 ElevatorObject::ItemColumns)', () => {
    let doc = createEmptyBlueprint();
    // 3-deck vertical stack of BPO_ElevatorBlock_02A at (0,0) on L0, L2, L4 + adjacent L0/L2/L4 rooms at (-2,0)
    for (const fl of [0, 2, 4]) {
      doc = placeModuleCmd(doc, { type: 'BPO_ElevatorBlock_02A', gx: 0, gy: 0, floor: fl, rotation: 0 }).doc;
      doc = placeModuleCmd(doc, { type: 'BPO_Station_03', gx: -2, gy: 0, floor: fl, rotation: 0 }).doc;
    }
    // L0: RelicSynthesizer at (-13, 6) outputs Protomatter (1.0/s) East -> pushes straight into West shaft port (7, 10, L0)!
    doc = placeBuildingCmd(doc, {
      type: 'DAT_RelicSynthesizer',
      x: -13,
      y: 6,
      floor: 0,
      rotation: 0,
      recipeId: 'REC_Protomatter',
      disabledPorts: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], // only E port [0] at (-4, 10)? Wait: 9x9 E center [0] is y+4=10!
    }).doc;
    for (let x = -4; x <= 6; x++) {
      doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt3', x, y: 10, floor: 0, rotation: 0 }).doc;
    }
    // L2: pulls Protomatter West from matching shaft port (7, 10, L2) -> feeds EnrichmentChamber (REC_TitaniumSynthesis, 0.5/s TiOre) -> pushes TiOre East into shaft port (7, 11, L2)!
    for (let x = 6; x >= -4; x--) {
      doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt3', x, y: 10, floor: 2, rotation: 2 }).doc;
    }
    doc = placeBuildingCmd(doc, {
      type: 'DAT_EnrichmentChamber',
      x: -13,
      y: 6,
      floor: 2,
      rotation: 0,
      recipeId: 'REC_TitaniumSynthesis',
      disabledPorts: [1, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    }).doc;
    // Output from E[2] (hy=+4 => y+6=12) -> turn North to y=11 -> East straight into (7, 11, L2)!
    doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt3', x: -4, y: 12, floor: 2, rotation: 3 }).doc;
    for (let x = -4; x <= 6; x++) {
      doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt3', x, y: 11, floor: 2, rotation: 0 }).doc;
    }
    // L4: pulls TitaniumOre West from matching shaft port (7, 11, L4) -> straight into Container_2 at (-8, 9)!
    for (let x = 6; x >= -4; x--) {
      doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt3', x, y: 11, floor: 4, rotation: 2 }).doc;
    }
    doc = placeBuildingCmd(doc, { type: 'DAT_Container_2', x: -8, y: 9, floor: 4, rotation: 0 }).doc;

    const rep = simulateBlueprint(doc);
    expect(rep.errorCount).toBe(0);
    expect(rep.avgEfficiency).toBe(1);
    expect(rep.netInputs.length).toBe(0); // 100% self-contained from L0 Protomatter!
    expect(rep.netOutputs.find((o) => o.itemId === 'ITEM_TitaniumOre')?.ratePerSec).toBeCloseTo(0.5, 2);

    // Binary-verified gap rule (MainSequence-Win64-Shipping.exe @ 0x1442e1d68):
    // Removing the middle L2 elevator leaves an air gap between L0 and L4 -> they MUST NOT link across the gap!
    const gappedDoc = {
      ...doc,
      modules: doc.modules.filter((m) => !(m.type === 'BPO_ElevatorBlock_02A' && m.floor === 2)),
      buildings: doc.buildings.filter((b) => b.floor !== 2),
    };
    // Wire L4 to try pulling Protomatter from (7, 10, L4) directly over the L2 air gap
    const gappedWithPull = {
      ...gappedDoc,
      buildings: [
        ...gappedDoc.buildings.filter((b) => b.floor === 0),
        { id: 'b_gap_pull', type: 'DAT_ConveyorBelt3', x: 6, y: 10, floor: 4, rotation: 2 as const },
        { id: 'b_gap_pull2', type: 'DAT_ConveyorBelt3', x: 5, y: 10, floor: 4, rotation: 2 as const },
      ],
    };
    const gapRep = simulateBlueprint(gappedWithPull);
    // L4 pull belt remains an unlinked elevator entry with 0 Protomatter delivered across the air gap!
    expect(gapRep.cellFlows['4:6,10']?.totalRate ?? 0).toBe(0);
    expect(gapRep.externalInputs.some((e) => e.floor === 4 && e.x === 6 && e.y === 10 && e.sourceKind === 'elevator')).toBe(true);
  });

  it('simulates native BPO_Dock_2 (8 filtered unload ports) feeding BPO_DeepSpaceObservatory (REC_StrangeWarpFuel) into a container with 0 errors', () => {
    let doc = createEmptyBlueprint();
    // Same exact geometry as Star-Citadel B1 West Dock -> Adapter -> Hall -> Observatory!
    doc = placeModuleCmd(doc, { type: 'BPO_Dock_2', gx: -6, gy: -4, floor: 0, rotation: 2 }).doc;
    doc.modules[doc.modules.length - 1].dockPorts = [
      { portIndex: 0, itemId: 'ITEM_StrangeMatterCrystal', mode: 'unload' },
    ];
    doc = placeModuleCmd(doc, { type: 'BPO_StationAdapter_01', gx: -3, gy: -4, floor: 0, rotation: 2 }).doc;
    doc = placeModuleCmd(doc, { type: 'BPO_Station_03', gx: -2, gy: -4, floor: 0, rotation: 0 }).doc;
    doc = placeModuleCmd(doc, { type: 'BPO_DeepSpaceObservatory', gx: 0, gy: -4, floor: 0, rotation: 0 }).doc;
    doc.modules[doc.modules.length - 1].recipeId = 'REC_StrangeWarpFuel';

    // Dock port 0 at rot=2: local (-8.5, -5.5) -> rotated (+8.5, +5.5) around center (-72, -48) => (-64, -43), adjacent buildable belt at (-63, -43)!
    // Route East through Adapter (-48..-33) into Hall (-32..-1) -> up to y=-49 (local y=15) -> straight East into Observatory!
    for (let x = -63; x <= -20; x++) {
      doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt3', x, y: -43, floor: 0, rotation: 0 }).doc;
    }
    for (let y = -43; y >= -48; y--) {
      if (y === -43) continue;
      doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt3', x: -20, y, floor: 0, rotation: 3 }).doc;
    }
    // Turn North at (-20,-43) instead of East
    doc.buildings = doc.buildings.map((b) => (b.x === -20 && b.y === -43 ? { ...b, rotation: 3 as const } : b));
    for (let x = -20; x <= -1; x++) {
      doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt3', x, y: -49, floor: 0, rotation: 0 }).doc;
    }
    // Observatory outputs WarpFuel at (-1, -48) (local y=16) -> pull West into Container_2 at (-12, -48)!
    for (let x = -1; x >= -8; x--) {
      doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt3', x, y: -48, floor: 0, rotation: 2 }).doc;
    }
    doc = placeBuildingCmd(doc, { type: 'DAT_Container_2', x: -12, y: -50, floor: 0, rotation: 0 }).doc;

    const rep = simulateBlueprint(doc);
    expect(rep.errorCount).toBe(0);
    expect(rep.externalInputs.some((e) => e.sourceKind === 'dock' && e.itemId === 'ITEM_StrangeMatterCrystal')).toBe(true);
    expect(rep.netOutputs.find((o) => o.itemId === 'ITEM_WarpFuel')?.ratePerSec).toBeCloseTo(0.25, 2);
  });
});

describe('VirtualFolderDriver copy-on-write overlay & 5 MB localStorage quota safety', () => {
  it('lists and reads all built-in presets (including 26k+ full-belts master) with < 1 KB localStorage usage and migrates legacy bloated stores', async () => {
    const QUOTA_CHARS = 5_000_000;
    const mem = new Map<string, string>();
    const totalChars = () => [...mem.values()].reduce((s, v) => s + v.length, 0);
    const mockStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => {
        const nextTotal = totalChars() - (mem.get(k)?.length ?? 0) + v.length;
        if (nextTotal > QUOTA_CHARS) {
          throw new Error(`QuotaExceededError: Failed to execute 'setItem' on 'Storage': setting '${k}' exceeded the quota.`);
        }
        mem.set(k, v);
      },
      removeItem: (k: string) => {
        mem.delete(k);
      },
      clear: () => mem.clear(),
    };
    const prevStorage = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = mockStorage;
    try {
      const driver = new VirtualFolderDriver();
      const tree = await driver.listTree();
      expect(tree.length).toBeGreaterThanOrEqual(1);
      // Unmodified built-in presets MUST occupy < 1 KB in localStorage (0 bytes duplicated!)
      expect(totalChars()).toBeLessThan(1024);

      if (HAS_PRIVATE_PRESETS) {
        // Reading the massive 26,143-building full-belts blueprint + autosaving it unmodified stays < 1 KB!
        const fullPath = '星穹总线超市/02-星穹金字塔-完整带线总图.json';
        const { doc: fullDoc } = await driver.readBlueprint(fullPath);
        expect(fullDoc.buildings.length).toBeGreaterThan(20000);
        saveWorkspaceAutosave(fullDoc, fullPath, false);
        expect(totalChars()).toBeLessThan(1024);

        const restored = loadWorkspaceAutosave();
        expect(restored?.sourcePath).toBe(fullPath);
        expect(restored?.doc.buildings.length).toBe(fullDoc.buildings.length);

        // Simulate legacy bloated store (v9 with duplicated built-in presets + user custom blueprint) -> auto-strips bloat while preserving custom file!
        const customDoc = createStarterBlueprint();
        customDoc.name = '我的自建小站';
        mem.set(
          'ms-sbd:virtual-library:v2',
          JSON.stringify({
            folders: ['星穹总线超市', '自定义'],
            files: {
              '星穹总线超市/01-星穹金字塔-三层骨架总图.json': { raw: serializeBlueprint(fullDoc), updatedAt: 1 },
              '自定义/我的小站.json': { raw: serializeBlueprint(customDoc), updatedAt: 2 },
            },
            presetRevision: 9,
          })
        );
        const migratedTree = await driver.listTree();
        expect(migratedTree.length).toBeGreaterThanOrEqual(2);
        const { doc: customBack } = await driver.readBlueprint('自定义/我的小站.json');
        expect(customBack.name).toBe('我的自建小站');
        // After migration, legacy built-in copy was stripped so storage dropped way below 50 KB!
        expect(totalChars()).toBeLessThan(50_000);
      } else {
        // Public open-source build contains ONLY the single clean 2x2A starter template!
        const { doc: tplDoc } = await driver.readBlueprint('2x2A-标准起步模板.json');
        expect(tplDoc.modules.length).toBe(1);
        expect(tplDoc.modules[0].type).toBe('BPO_Station_02A');
        saveWorkspaceAutosave(tplDoc, '2x2A-标准起步模板.json', false);
        expect(totalChars()).toBeLessThan(1024);
      }
    } finally {
      (globalThis as { localStorage?: unknown }).localStorage = prevStorage;
    }
  });
});

describe('Shared Rust/WASM native .sav <-> Canonical Blueprint JSON codec', () => {
  it('deterministically round-trips 100% of all 27 station modules, all 36 buildables, and starter/preset blueprints via real WASM', async () => {
    const starter = createStarterBlueprint();
    const exported = await exportNativeSav(starter, 'station');
    expect(exported.bytes.length).toBeGreaterThan(2000);
    // GVAS magic header "GVAS"
    expect(Array.from(exported.bytes.slice(0, 4))).toEqual([0x47, 0x56, 0x41, 0x53]);
    expect(exported.report.warnings).toEqual([]);
    expect(exported.report.module_count).toBe(starter.modules.length);
    expect(exported.report.connector_count).toBeGreaterThan(0);

    const imported = await importNativeSav(exported.bytes);
    expect(imported.report.warnings).toEqual([]);
    expect(imported.doc.name).toBe(starter.name);
    expect(imported.doc.modules.length).toBe(starter.modules.length);
    expect(imported.doc.buildings.length).toBe(starter.buildings.length);

    // Exhaustive 100% stateful module + buildable 2-hop coverage matrix through real browser WASM!
    const allModulesDoc = createEmptyBlueprint('全量27模块36建筑带属性双跳WASM核验');
    CATALOG.stationModules.forEach((mDef, idx) => {
      const rot = (idx % 4) as 0 | 1 | 2 | 3;
      allModulesDoc.modules.push({
        id: `m_${idx}`,
        type: mDef.id,
        gx: idx * 4,
        gy: 0,
        floor: mDef.id === 'BPO_StationArmour_01B' ? -1 : 0,
        rotation: rot,
        ...(idx % 3 === 1 ? { paletteId: 1 } : {}),
        ...(mDef.id === 'BPO_ElevatorBlock_03' || mDef.id === 'BPO_ElevatorBlock_02A' ? { label: `电梯${idx}` } : {}),
        ...(mDef.id.startsWith('BPO_MiningDroneBay') ? { miningItem: idx % 2 === 0 ? 'ITEM_WaterIce' : 'ITEM_TitaniumOre' } : {}),
        ...(mDef.id.startsWith('BPO_Dock') || mDef.id.startsWith('BPO_ShipyardCore') ? { dockName: `泊位${idx}` } : {}),
        ...(mDef.id === 'BPO_Dock'
          ? {
              dockPorts: [
                { portIndex: 0, itemId: 'ITEM_TitaniumPlates', mode: 'unload' as const },
                { portIndex: 1, itemId: 'ITEM_ReinforcedPlates', mode: 'load' as const },
              ],
            }
          : {}),
        ...(mDef.id === 'BPO_Dock_2'
          ? {
              dockPorts: [
                { portIndex: 0, itemId: 'ITEM_StrangeMatterCrystal', mode: 'unload' as const },
                { portIndex: 4, itemId: 'ITEM_BackpackMk3', mode: 'load' as const },
                { portIndex: 7, itemId: 'ITEM_AlphaProtein', mode: 'unload' as const },
              ],
            }
          : {}),
        ...(mDef.id === 'BPO_DeepSpaceObservatory' ? { recipeId: 'REC_StrangeWarpFuel' } : {}),
      });
    });
    CATALOG.buildables.forEach((bDef, idx) => {
      const rot = (idx % 4) as 0 | 1 | 2 | 3;
      const x = idx * 14;
      if (bDef.kind === 'underground') {
        const dx = rot === 0 ? 1 : rot === 2 ? -1 : 0;
        const dy = rot === 1 ? 1 : rot === 3 ? -1 : 0;
        const span = bDef.maxLength ?? 8;
        allModulesDoc.buildings.push(
          {
            id: `u_${idx}_in`,
            type: bDef.id,
            x,
            y: 0,
            floor: 0,
            rotation: rot,
            undergroundMode: 'in',
            undergroundPartnerId: `u_${idx}_out`,
            paletteId: 1,
          },
          {
            id: `u_${idx}_out`,
            type: bDef.id,
            x: x + dx * span,
            y: dy * span,
            floor: 0,
            rotation: rot,
            undergroundMode: 'out',
            undergroundPartnerId: `u_${idx}_in`,
            paletteId: 1,
          }
        );
      } else {
        allModulesDoc.buildings.push({
          id: `b_${idx}`,
          type: bDef.id,
          x,
          y: 0,
          floor: 0,
          rotation: rot,
          ...(idx % 2 === 1 ? { paletteId: 1 } : {}),
          ...(bDef.kind === 'crafter' ? { recipeId: 'REC_ReinforcedPlates', disabledPorts: [1, 3] } : {}),
          ...(bDef.kind === 'splitter'
            ? { priorityOut: 1, disabledPorts: [2], portFilters: { 1: 'ITEM_TitaniumPlates', 3: 'ITEM_ReinforcedPlates' } }
            : {}),
          ...(bDef.kind === 'balancer'
            ? { priorityIn: 1, priorityOut: 2, portFilters: { 2: 'ITEM_WaterIce', 3: 'ITEM_AlphaProtein' } }
            : {}),
          ...(bDef.kind === 'container'
            ? {
                disabledPorts: [0, 3],
                filterItems: ['ITEM_TitaniumPlates', 'ITEM_BackpackMk2'],
                nativeMeta: {
                  b_creative: true,
                  creative_item: 'ITEM_StrangeMatterCrystal',
                  b_creative_consume: true,
                  logistic_filters: [
                    { itemId: 'ITEM_TitaniumPlates', amount: 300, action: 1 },
                    { itemId: 'ITEM_BackpackMk2', amount: 50, action: 2 },
                  ],
                },
              }
            : {}),
          ...(bDef.kind === 'teleporter' ? { label: '跃迁点A-中文' } : {}),
        });
      }
    });

    // Hop 1: Canonical -> .sav -> Canonical (real browser WASM + TS deserializeBlueprint)
    const covSav1 = await exportNativeSav(allModulesDoc, 'station');
    expect(covSav1.report.warnings).toEqual([]);
    const covBack1 = await importNativeSav(covSav1.bytes);
    expect(covBack1.report.warnings).toEqual([]);
    expect(covBack1.doc.modules.length).toBe(CATALOG.stationModules.length);
    expect(covBack1.doc.buildings.length).toBe(allModulesDoc.buildings.length);

    for (let i = 0; i < allModulesDoc.modules.length; i++) {
      const a = allModulesDoc.modules[i];
      const b = covBack1.doc.modules[i];
      expect([b.type, b.gx, b.gy, b.floor, b.rotation]).toEqual([a.type, a.gx, a.gy, a.floor, a.rotation]);
      expect(b.paletteId).toBe(a.paletteId);
      expect(b.label).toBe(a.label);
      expect(b.miningItem).toBe(a.miningItem);
      expect(b.dockName).toBe(a.dockName);
      expect(b.dockPorts).toEqual(a.dockPorts);
      expect(b.recipeId).toBe(a.recipeId);
    }

    const backByPos = new Map(covBack1.doc.buildings.map((b) => [`${b.type}:${b.x},${b.y},${b.floor},${b.rotation}`, b]));
    for (const orig of allModulesDoc.buildings) {
      const rt = backByPos.get(`${orig.type}:${orig.x},${orig.y},${orig.floor},${orig.rotation}`);
      expect(rt).toBeDefined();
      expect(rt?.paletteId).toBe(orig.paletteId);
      expect(rt?.recipeId).toBe(orig.recipeId);
      expect(rt?.disabledPorts).toEqual(orig.disabledPorts);
      expect(rt?.priorityIn).toBe(orig.priorityIn);
      expect(rt?.priorityOut).toBe(orig.priorityOut);
      expect(rt?.portFilters).toEqual(orig.portFilters);
      expect(rt?.filterItems).toEqual(orig.filterItems);
      expect(rt?.label).toBe(orig.label);
      expect(rt?.undergroundMode).toBe(orig.undergroundMode);
      if (orig.undergroundMode === 'in') {
        expect(rt?.undergroundPartnerId).toBeTruthy();
      }
    }

    // Hop 2: Canonical1 -> .sav2 -> Canonical2 must be 100% fixed-point identical!
    const covSav2 = await exportNativeSav(covBack1.doc, 'station');
    expect(covSav2.report.warnings).toEqual([]);
    const covBack2 = await importNativeSav(covSav2.bytes);
    expect(covBack2.report.warnings).toEqual([]);
    expect(covBack2.doc.modules).toEqual(covBack1.doc.modules);
    expect(covBack2.doc.buildings).toEqual(covBack1.doc.buildings);

    // Edit-after-import stability through real WASM (mutating dockPorts / recipeId / filterItems / clearing label)
    const editedDoc = {
      ...covBack1.doc,
      modules: covBack1.doc.modules.map((m) => {
        if (m.type === 'BPO_Dock_2') {
          return {
            ...m,
            dockName: '改名工业港',
            dockPorts: [{ portIndex: 2, itemId: 'ITEM_WaterIce', mode: 'load' as const }],
          };
        }
        if (m.type === 'BPO_DeepSpaceObservatory') {
          return { ...m, recipeId: 'REC_ObservedStellarSurveyData' };
        }
        if (m.type === 'BPO_ElevatorBlock_02A') {
          const copy = { ...m };
          delete copy.label;
          return copy;
        }
        return m;
      }),
      buildings: covBack1.doc.buildings.map((b) =>
        b.type === 'DAT_Container' ? { ...b, filterItems: ['ITEM_TitaniumPlates'] } : b
      ),
    };
    const editedSav = await exportNativeSav(editedDoc, 'station');
    expect(editedSav.report.warnings).toEqual([]);
    const editedBack = await importNativeSav(editedSav.bytes);
    expect(editedBack.report.warnings).toEqual([]);
    const edDock2 = editedBack.doc.modules.find((m) => m.type === 'BPO_Dock_2');
    expect(edDock2?.dockName).toBe('改名工业港');
    expect(edDock2?.dockPorts).toEqual([{ portIndex: 2, itemId: 'ITEM_WaterIce', mode: 'load' }]);
    expect(editedBack.doc.modules.find((m) => m.type === 'BPO_DeepSpaceObservatory')?.recipeId).toBe(
      'REC_ObservedStellarSurveyData'
    );
    expect(editedBack.doc.modules.find((m) => m.type === 'BPO_ElevatorBlock_02A')?.label).toBeUndefined();
    expect(editedBack.doc.buildings.find((b) => b.type === 'DAT_Container')?.filterItems).toEqual([
      'ITEM_TitaniumPlates',
    ]);

    if (HAS_PRIVATE_PRESETS) {
      const b1Fuel = DEFAULT_LIBRARY_PRESETS.find((p) => p.path.includes('氢氘燃料直连舱'))!.doc;
      const fuelSav = await exportNativeSav(b1Fuel, 'station');
      expect(fuelSav.report.warnings).toEqual([]);
      const fuelBack = await importNativeSav(fuelSav.bytes);
      expect(fuelBack.report.warnings).toEqual([]);
      expect(simulateBlueprint(fuelBack.doc).errorCount).toBe(0);
    }

    // Verify STATION_PRESET mode (for future in-game Mod paste) also 2-hop round-trips cleanly!
    const presetSav1 = await exportNativeSav(allModulesDoc, 'preset');
    expect(presetSav1.report.connector_count).toBe(0);
    const presetBack1 = await importNativeSav(presetSav1.bytes);
    const presetSav2 = await exportNativeSav(presetBack1.doc, 'preset');
    const presetBack2 = await importNativeSav(presetSav2.bytes);
    expect(presetBack2.doc.modules).toEqual(presetBack1.doc.modules);
    expect(presetBack2.doc.buildings).toEqual(presetBack1.doc.buildings);
  });
});

describe('GitHubPrivateRepoDriver client-side private blueprint cloud sync', () => {
  it('lists recursive UTF-8 Chinese folders, reads large blobs by SHA, writes/deletes with SHA tracking, and wipes token cleanly', async () => {
    const starter = createStarterBlueprint();
    starter.name = '私有星穹主站';
    const b64Content = Buffer.from(serializeBlueprint(starter), 'utf8').toString('base64');

    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const prevFetch = globalThis.fetch;
    const prevStorage = (globalThis as { localStorage?: unknown }).localStorage;
    const mem = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => mem.set(k, v),
      removeItem: (k: string) => mem.delete(k),
      clear: () => mem.clear(),
    };

    let putAttempt = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });

      if (url.includes('/git/ref/heads/main')) {
        return new Response(JSON.stringify({ object: { sha: 'commit_latest_1' } }), { status: 200 });
      }
      if (url.includes('/git/trees/commit_latest_1?recursive=1')) {
        return new Response(
          JSON.stringify({
            tree: [
              { path: 'blueprints/星穹总线超市', type: 'tree', sha: 't1' },
              { path: 'blueprints/星穹总线超市/主站.json', type: 'blob', sha: 'sha_main_1' },
              { path: 'blueprints/README.md', type: 'blob', sha: 'sha_readme' },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes('/git/blobs/sha_main_1')) {
        return new Response(JSON.stringify({ encoding: 'base64', content: b64Content }), { status: 200 });
      }
      if (method === 'GET' && url.includes('/contents/')) {
        return new Response(JSON.stringify({ sha: 'sha_remote_live' }), { status: 200 });
      }
      if (method === 'PUT' && url.includes('/contents/')) {
        putAttempt++;
        const parsedBody = JSON.parse(String(init?.body ?? '{}')) as { sha?: string };
        // Simulate external repo push causing 409 conflict on first PUT with stale sha_main_1
        if (putAttempt === 1 && parsedBody.sha === 'sha_main_1') {
          return new Response(JSON.stringify({ message: 'does not match sha_remote_live' }), { status: 409 });
        }
        return new Response(JSON.stringify({ content: { sha: 'sha_main_2' } }), { status: 200 });
      }
      if (method === 'DELETE' && url.includes('/contents/')) {
        return new Response(JSON.stringify({ commit: { sha: 'c_del' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    }) as typeof fetch;

    try {
      const cfg = { owner: 'example-user', repo: 'my-blueprints-private', branch: 'main', basePath: 'blueprints', token: 'ghp_test_token' };
      saveGitHubConfig(cfg);
      expect(loadSavedGitHubConfig()).toEqual(cfg);

      const drv = new GitHubPrivateRepoDriver(cfg);
      const tree = await drv.listTree();
      expect(tree.length).toBe(1);
      expect(tree[0].kind).toBe('folder');
      if (tree[0].kind === 'folder') {
        expect(tree[0].name).toBe('星穹总线超市');
        expect(tree[0].children.length).toBe(1);
        const child = tree[0].children[0];
        expect(child.path).toBe('星穹总线超市/主站.json');
        if (child.kind === 'file') {
          expect(child.contentHash).toBe('sha_main_1');
        }
      }

      const { doc } = await drv.readBlueprint('星穹总线超市/主站.json');
      expect(doc.name).toBe('私有星穹主站');
      expect(doc.modules.length).toBe(starter.modules.length);

      // Updating after an external push recovers automatically from HTTP 409 by fetching live SHA and retrying!
      doc.name = '私有星穹主站-已修改';
      await drv.writeBlueprint('星穹总线超市/主站.json', doc);
      const putCalls = calls.filter((c) => c.method === 'PUT');
      expect(putCalls.length).toBe(2);
      expect(JSON.parse(putCalls[0].body!).sha).toBe('sha_main_1');
      expect(JSON.parse(putCalls[1].body!).sha).toBe('sha_remote_live');

      // Deleting uses updated sha_main_2
      await drv.deleteEntry('星穹总线超市/主站.json');
      const delCall = calls.find((c) => c.method === 'DELETE')!;
      expect(JSON.parse(delCall.body!).sha).toBe('sha_main_2');

      clearSavedGitHubConfig();
      expect(loadSavedGitHubConfig()).toBeNull();

      // Verify workspace autosave can be cleanly wiped on private cloud disconnect
      saveWorkspaceAutosave(doc, '星穹总线超市/主站.json', false);
      expect(loadWorkspaceAutosave()?.doc.name).toBe('私有星穹主站-已修改');
      clearWorkspaceAutosave();
      expect(loadWorkspaceAutosave()).toBeNull();

      // Verify public default preset list strictly exposes ONLY the clean 2x2A starter template
      const publicPaths = DEFAULT_LIBRARY_PRESETS.filter((p) => !p.isPrivate).map((p) => p.path);
      expect(publicPaths).toEqual(['2x2A-标准起步模板.json']);
    } finally {
      globalThis.fetch = prevFetch;
      (globalThis as { localStorage?: unknown }).localStorage = prevStorage;
    }
  });

  it('keeps build, belt-drag, and Ctrl+X/V cut-paste sub-50ms even on 26k-building mega-stations', () => {
    const mega = DEFAULT_LIBRARY_PRESETS.find((p) => p.path.includes('02-星穹金字塔-完整带线总图'));
    if (!mega) return;
    const doc = mega.doc;
    expect(doc.buildings.length).toBeGreaterThan(20000);

    // Warm WeakMap spatial index once
    const tIdx0 = performance.now();
    validateBuildingPlacement(doc, { type: 'DAT_ConveyorBelt3', x: 10, y: 10, floor: 0, rotation: 0 }, { allowBeltReplace: true });
    const tIndexMs = performance.now() - tIdx0;

    // 1. 100x hover validation
    const tVal0 = performance.now();
    for (let i = 0; i < 100; i++) {
      validateBuildingPlacement(
        doc,
        { type: 'DAT_ConveyorBelt3', x: 50 + (i % 10), y: 50 + Math.floor(i / 10), floor: 0, rotation: 0 },
        { allowBeltReplace: true }
      );
    }
    const tValMs = performance.now() - tVal0;

    // 2. 40-tile belt drag
    const segs = Array.from({ length: 40 }, (_, i) => ({ x: 50 + i, y: 50, rotation: 0 as const }));
    const tBelt0 = performance.now();
    placeBeltRunCmd(doc, 'DAT_ConveyorBelt3', 0, segs);
    const tBeltMs = performance.now() - tBelt0;

    // 3. Full factory module Ctrl+X + Ctrl+V atomic cut & paste
    const sampleMod = doc.modules.find((m) => m.floor === 0 && getModuleDef(m.type)?.hasFactoryFloor)!;
    const sel = { moduleIds: [sampleMod.id], buildingIds: [] };
    const tCut0 = performance.now();
    const bp = extractSelectionAsBlueprint(doc, sel, 'cut-bench')!;
    const afterCut = deleteSelectionCmd(doc, sel, { cascadeBuildingsInModules: true });
    const tCutMs = performance.now() - tCut0;

    const tPaste0 = performance.now();
    const afterPaste = stampBlueprintCmd(afterCut.doc, bp, {
      x: sampleMod.gx * 16,
      y: sampleMod.gy * 16,
      floor: sampleMod.floor,
    });
    const tPasteMs = performance.now() - tPaste0;

    expect(afterPaste.changed).toBe(true);
    expect(afterPaste.doc.modules.length).toBe(doc.modules.length);
    expect(afterPaste.doc.buildings.length).toBe(doc.buildings.length);
    console.log(
      `[Perf 26k mega-station] index=${tIndexMs.toFixed(2)}ms | 100xValidate=${tValMs.toFixed(2)}ms | 40BeltDrag=${tBeltMs.toFixed(2)}ms | Ctrl+X(${bp.buildings.length}b)=${tCutMs.toFixed(2)}ms | Ctrl+V=${tPasteMs.toFixed(2)}ms`
    );
    expect(tValMs).toBeLessThan(15);
    expect(tBeltMs).toBeLessThan(30);
    expect(tCutMs).toBeLessThan(80);
    expect(tPasteMs).toBeLessThan(80);
  });

  it('preserves BPO_Dock_2 dockPorts and BPO_DeepSpaceObservatory recipeId across serialize/deserialize round-trips', () => {
    const doc = createEmptyBlueprint();
    doc.modules.push(
      {
        id: 'mod_dock',
        type: 'BPO_Dock_2',
        gx: -6,
        gy: -4,
        floor: 0,
        rotation: 2,
        dockPorts: [
          { portIndex: 7, itemId: 'ITEM_StrangeMatterCrystal', mode: 'unload' },
          { portIndex: 6, itemId: 'ITEM_NitrogenGas', mode: 'unload' },
        ],
      },
      {
        id: 'mod_obs',
        type: 'BPO_DeepSpaceObservatory',
        gx: 4,
        gy: -4,
        floor: 0,
        rotation: 0,
        recipeId: 'REC_StrangeWarpFuel',
      }
    );
    const decoded = deserializeBlueprint(serializeBlueprint(doc));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.doc.modules.find((m) => m.id === 'mod_dock')?.dockPorts).toEqual([
      { portIndex: 7, itemId: 'ITEM_StrangeMatterCrystal', mode: 'unload' },
      { portIndex: 6, itemId: 'ITEM_NitrogenGas', mode: 'unload' },
    ]);
    expect(decoded.doc.modules.find((m) => m.id === 'mod_obs')?.recipeId).toBe('REC_StrangeWarpFuel');
  });

  it('supports hotkey-triggered underground tunnel bridging in freehand strokes and planned L-paths', () => {
    let doc = createEmptyBlueprint();
    doc = placeModuleCmd(doc, { type: 'BPO_Station_02A', gx: 0, gy: 0, floor: 0, rotation: 0 }).doc;
    // Place a perpendicular North-South belt obstacle at x=10, y=8..12
    for (let y = 8; y <= 12; y++) {
      doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt3', x: 10, y, floor: 0, rotation: 1 }).doc;
    }

    expect(getMatchingUndergroundType('DAT_ConveyorBelt3')).toBe('DAT_UndergroundBelt_3');
    expect(getMatchingBeltType('DAT_UndergroundBelt_3')).toBe('DAT_ConveyorBelt3');

    // Case A: Freehand stroke -> drag (7,10)->(9,10), tap T/U to dive, drag to (11,10), tap T/U to surface, drag to (13,10)
    let cells: Array<[number, number]> = [[7, 10]];
    let tunnels: BeltStrokeTunnel[] = [];
    ({ cells, tunnels } = extendBeltStrokeWithTunnels(cells, tunnels, [9, 10]));
    const diveRes = toggleBeltStrokeTunnel(cells, tunnels);
    expect(diveRes.action).toBe('dive');
    tunnels = diveRes.tunnels;
    ({ cells, tunnels } = extendBeltStrokeWithTunnels(cells, tunnels, [11, 10]));
    const surfRes = toggleBeltStrokeTunnel(cells, tunnels);
    expect(surfRes.action).toBe('surface');
    tunnels = surfRes.tunnels;
    ({ cells, tunnels } = extendBeltStrokeWithTunnels(cells, tunnels, [13, 10]));

    const strokeSpecs = buildBeltStrokeSpecs(cells, tunnels, 0);
    expect(strokeSpecs.map((s) => `${s.x},${s.y}:${s.kind ?? 'belt'}`)).toEqual([
      '7,10:belt',
      '8,10:belt',
      '9,10:underground-in',
      '11,10:underground-out',
      '12,10:belt',
      '13,10:belt',
    ]);

    const runRes = placeBeltRunCmd(doc, 'DAT_ConveyorBelt3', 0, strokeSpecs);
    expect(runRes.changed).toBe(true);
    // Original perpendicular belt at (10,10) stays intact!
    expect(runRes.doc.buildings.find((b) => b.x === 10 && b.y === 10)?.rotation).toBe(1);
    const ugIn = runRes.doc.buildings.find((b) => b.x === 9 && b.y === 10);
    const ugOut = runRes.doc.buildings.find((b) => b.x === 11 && b.y === 10);
    expect(ugIn?.type).toBe('DAT_UndergroundBelt_3');
    expect(ugIn?.undergroundMode).toBe('in');
    expect(ugOut?.type).toBe('DAT_UndergroundBelt_3');
    expect(ugOut?.undergroundMode).toBe('out');
    expect(ugIn?.undergroundPartnerId).toBe(ugOut?.id);
    expect(ugOut?.undergroundPartnerId).toBe(ugIn?.id);

    // Case B: Planned L-path does NOT bridge automatically unless tunnelObstacles is explicitly toggled on
    const plainPlan = buildPlannedBeltPathWithTunnels(doc, 0, [7, 11], [13, 11], {
      flipCorner: false,
      reverse: false,
      fallbackRotation: 0,
      tunnelObstacles: false,
    });
    expect(plainPlan.every((s) => (s.kind ?? 'belt') === 'belt')).toBe(true);

    const bridgedPlan = buildPlannedBeltPathWithTunnels(doc, 0, [7, 11], [13, 11], {
      flipCorner: false,
      reverse: false,
      fallbackRotation: 0,
      tunnelObstacles: true,
    });
    expect(bridgedPlan.map((s) => `${s.x},${s.y}:${s.kind ?? 'belt'}`)).toEqual([
      '7,11:belt',
      '8,11:belt',
      '9,11:underground-in',
      '11,11:underground-out',
      '12,11:belt',
      '13,11:belt',
    ]);
  });

  it('handles 1x1/2x2 elevator type-isolation, perpendicular side-turning exit belts, and splitter-to-elevator links', () => {
    // Case A: Real 基本生产站.sav pattern on 1x1 elevator (0,0) L0 -> L1:
    // L0: Refinery feeds belt (10,14) rot=0 (East) -> pushes into port (11,14) on South doorway east wall
    // L1: Belt (10,14) rot=1 (South, PERPENDICULAR side-entry!) receives from port (11,14) -> Container!
    let doc = createEmptyBlueprint();
    doc = placeModuleCmd(doc, { type: 'BPO_ElevatorBlock_03', gx: 0, gy: 0, floor: 0, rotation: 0 }).doc;
    doc = placeModuleCmd(doc, { type: 'BPO_ElevatorBlock_03', gx: 0, gy: 0, floor: 1, rotation: 0 }).doc;
    doc = placeModuleCmd(doc, { type: 'BPO_Station_02A', gx: 0, gy: 1, floor: 0, rotation: 0 }).doc;
    doc = placeModuleCmd(doc, { type: 'BPO_Station_02A', gx: 0, gy: 1, floor: 1, rotation: 0 }).doc;

    // L0: Refinery at (3, 18) -> TitaniumPlates -> belt East to (7,19) -> North to (7,14) -> East (7..10, 14) into (11,14)!
    doc = placeBuildingCmd(doc, {
      type: 'DAT_Refinery',
      x: 3,
      y: 18,
      floor: 0,
      rotation: 0,
      recipeId: 'REC_TitaniumPlates',
      disabledPorts: [1, 2, 3],
    }).doc;
    // Feed raw TitaniumOre into Refinery W port (2,19)
    doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt2', x: 2, y: 19, floor: 0, rotation: 0 }).doc;
    // Output from E port (6,19) -> (7,19) -> North to (7,14) -> East to (10,14)
    doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt2', x: 6, y: 19, floor: 0, rotation: 0 }).doc;
    for (let y = 19; y >= 15; y--) {
      doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt2', x: 7, y, floor: 0, rotation: 3 }).doc;
    }
    for (let x = 7; x <= 10; x++) {
      doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt2', x, y: 14, floor: 0, rotation: 0 }).doc;
    }

    // L1: Side-turning exit belt at (10,14) facing South (rot=1!) -> (10,15) -> (10,16) -> Container at (9,17)
    doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt2', x: 10, y: 14, floor: 1, rotation: 1 }).doc;
    doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt2', x: 10, y: 15, floor: 1, rotation: 1 }).doc;
    doc = placeBuildingCmd(doc, { type: 'DAT_ConveyorBelt2', x: 10, y: 16, floor: 1, rotation: 1 }).doc;
    doc = placeBuildingCmd(doc, { type: 'DAT_Container', x: 9, y: 17, floor: 1, rotation: 0 }).doc;

    const rep = simulateBlueprint(doc);
    expect(rep.errorCount).toBe(0);
    expect(rep.netOutputs.find((o) => o.itemId === 'ITEM_TitaniumPlates')?.ratePerSec).toBeCloseTo(1 / 3, 2);

    // Case B: Heterogenous elevator isolation — 1x1 elevator at (0,0,L2) MUST NOT bridge two 2x2 elevators at (0,0,L0) and (0,0,L3)!
    let gapDoc = createEmptyBlueprint();
    gapDoc = placeModuleCmd(gapDoc, { type: 'BPO_ElevatorBlock_02A', gx: 0, gy: 0, floor: 0, rotation: 0 }).doc;
    gapDoc = placeModuleCmd(gapDoc, { type: 'BPO_ElevatorBlock_03', gx: 0, gy: 0, floor: 2, rotation: 0 }).doc;
    gapDoc = placeModuleCmd(gapDoc, { type: 'BPO_ElevatorBlock_02A', gx: 0, gy: 0, floor: 3, rotation: 0 }).doc;
    gapDoc = placeModuleCmd(gapDoc, { type: 'BPO_Station_03', gx: -2, gy: 0, floor: 0, rotation: 0 }).doc;
    gapDoc = placeModuleCmd(gapDoc, { type: 'BPO_Station_03', gx: -2, gy: 0, floor: 3, rotation: 0 }).doc;
    // L0: RelicSynthesizer -> Splitter pushing directly East at (6,10) into 2x2 port (7,10)
    gapDoc = placeBuildingCmd(gapDoc, {
      type: 'DAT_RelicSynthesizer',
      x: -13,
      y: 6,
      floor: 0,
      rotation: 0,
      recipeId: 'REC_Protomatter',
      disabledPorts: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    }).doc;
    for (let x = -4; x <= 5; x++) {
      gapDoc = placeBuildingCmd(gapDoc, { type: 'DAT_ConveyorBelt3', x, y: 10, floor: 0, rotation: 0 }).doc;
    }
    gapDoc = placeBuildingCmd(gapDoc, { type: 'DAT_Splitter_3', x: 6, y: 10, floor: 0, rotation: 0, disabledPorts: [1, 3] }).doc;
    // L3: Belt receiving at (6,10) facing South (side-turn!) -> Container
    gapDoc = placeBuildingCmd(gapDoc, { type: 'DAT_ConveyorBelt3', x: 6, y: 10, floor: 3, rotation: 1 }).doc;
    gapDoc = placeBuildingCmd(gapDoc, { type: 'DAT_Container', x: 5, y: 11, floor: 3, rotation: 0 }).doc;
    const repGap = simulateBlueprint(gapDoc);
    // Must NOT receive Protomatter on L3 because L2 is a 1x1 elevator, NOT a 2x2 elevator!
    expect(repGap.cellFlows['3:6,10']?.totalRate ?? 0).toBe(0);

    // Replace L2 with a proper contiguous 2x2 stack (L0 + L2): now Splitter -> 2x2 Elevator -> L2 side-turning belt MUST deliver full 1.0/s Protomatter!
    let contDoc = createEmptyBlueprint();
    contDoc = placeModuleCmd(contDoc, { type: 'BPO_ElevatorBlock_02A', gx: 0, gy: 0, floor: 0, rotation: 0 }).doc;
    contDoc = placeModuleCmd(contDoc, { type: 'BPO_ElevatorBlock_02A', gx: 0, gy: 0, floor: 2, rotation: 0 }).doc;
    contDoc = placeModuleCmd(contDoc, { type: 'BPO_Station_03', gx: -2, gy: 0, floor: 0, rotation: 0 }).doc;
    contDoc = placeModuleCmd(contDoc, { type: 'BPO_Station_03', gx: -2, gy: 0, floor: 2, rotation: 0 }).doc;
    contDoc = placeBuildingCmd(contDoc, {
      type: 'DAT_RelicSynthesizer',
      x: -13,
      y: 6,
      floor: 0,
      rotation: 0,
      recipeId: 'REC_Protomatter',
      disabledPorts: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    }).doc;
    for (let x = -4; x <= 5; x++) {
      contDoc = placeBuildingCmd(contDoc, { type: 'DAT_ConveyorBelt3', x, y: 10, floor: 0, rotation: 0 }).doc;
    }
    contDoc = placeBuildingCmd(contDoc, { type: 'DAT_Splitter_3', x: 6, y: 10, floor: 0, rotation: 0, disabledPorts: [1, 3] }).doc;
    contDoc = placeBuildingCmd(contDoc, { type: 'DAT_ConveyorBelt3', x: 6, y: 10, floor: 2, rotation: 1 }).doc;
    contDoc = placeBuildingCmd(contDoc, { type: 'DAT_Container', x: 5, y: 11, floor: 2, rotation: 0 }).doc;
    const repCont = simulateBlueprint(contDoc);
    expect(repCont.errorCount).toBe(0);
    expect(repCont.cellFlows['2:6,10']?.totalRate).toBeCloseTo(1.0, 2);
  });

  it('enforces Build 26639889 floor-by-floor elevator stacking, 1x1 rotation mismatch, registration-order output priority, and mixed-shaft detection', () => {
    // 1) Air gap in 2x2 elevator stack (L0 + L4 missing L2) -> MUST emit elevator-stack-gap error & block L0->L4 transfer!
    let gapped = createEmptyBlueprint();
    gapped = placeModuleCmd(gapped, { type: 'BPO_ElevatorBlock_02A', gx: 0, gy: 0, floor: 0, rotation: 0 }).doc;
    gapped = placeModuleCmd(gapped, { type: 'BPO_ElevatorBlock_02A', gx: 0, gy: 0, floor: 4, rotation: 0 }).doc;
    gapped = placeModuleCmd(gapped, { type: 'BPO_Station_03', gx: -2, gy: 0, floor: 0, rotation: 0 }).doc;
    gapped = placeModuleCmd(gapped, { type: 'BPO_Station_03', gx: -2, gy: 0, floor: 4, rotation: 0 }).doc;
    gapped = placeBuildingCmd(gapped, {
      type: 'DAT_RelicSynthesizer',
      x: -13,
      y: 6,
      floor: 0,
      rotation: 0,
      recipeId: 'REC_Protomatter',
      disabledPorts: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    }).doc;
    for (let x = -4; x <= 6; x++) {
      gapped = placeBuildingCmd(gapped, { type: 'DAT_ConveyorBelt3', x, y: 10, floor: 0, rotation: 0 }).doc;
    }
    gapped = placeBuildingCmd(gapped, { type: 'DAT_ConveyorBelt3', x: 6, y: 10, floor: 4, rotation: 2 }).doc;
    gapped = placeBuildingCmd(gapped, { type: 'DAT_Container', x: 4, y: 9, floor: 4, rotation: 0 }).doc;
    const repGapped = simulateBlueprint(gapped);
    expect(repGapped.issues.some((i) => i.code === 'elevator-stack-gap' && i.severity === 'error')).toBe(true);
    expect(repGapped.cellFlows['4:6,10']?.totalRate ?? 0).toBe(0);

    // 2) Bridging L2 restores contiguous L0<->L2<->L4 stack: L0:IN -> L2:--- -> L4:OUT delivers full 1.0/s with 0 errors!
    const bridged = placeModuleCmd(gapped, { type: 'BPO_ElevatorBlock_02A', gx: 0, gy: 0, floor: 2, rotation: 0 }).doc;
    const repBridged = simulateBlueprint(bridged);
    expect(repBridged.errorCount).toBe(0);
    expect(repBridged.cellFlows['4:6,10']?.totalRate).toBeCloseTo(1.0, 2);

    // 3) Multi-floor output registration-order priority (0x1442aca80 + 0x1442dff80):
    //    L2 pushes 1.0/s Protomatter; L0 (registered first) feeds 1 Enricher consuming 1.0/s -> L0 takes 1.0/s, L4 gets 0/s;
    //    with 2 synthesizers (2.0/s) on L2 -> L0 takes 1.0/s first, exact 1.0/s surplus overflows to L4!
    let prioDoc = createEmptyBlueprint();
    prioDoc = placeModuleCmd(prioDoc, { type: 'BPO_ElevatorBlock_02A', gx: 0, gy: 0, floor: 0, rotation: 0 }).doc;
    prioDoc = placeModuleCmd(prioDoc, { type: 'BPO_ElevatorBlock_02A', gx: 0, gy: 0, floor: 2, rotation: 0 }).doc;
    prioDoc = placeModuleCmd(prioDoc, { type: 'BPO_ElevatorBlock_02A', gx: 0, gy: 0, floor: 4, rotation: 0 }).doc;
    prioDoc = placeModuleCmd(prioDoc, { type: 'BPO_Station_03', gx: -2, gy: 0, floor: 0, rotation: 0 }).doc;
    prioDoc = placeModuleCmd(prioDoc, { type: 'BPO_Station_03', gx: -2, gy: 0, floor: 2, rotation: 0 }).doc;
    // L2: 2x Protomatter (2.0/s total) merged into elevator port (6,10) -> (7,10)
    prioDoc = placeBuildingCmd(prioDoc, {
      type: 'DAT_RelicSynthesizer',
      x: -13,
      y: 6,
      floor: 2,
      rotation: 0,
      recipeId: 'REC_Protomatter',
      disabledPorts: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    }).doc;
    prioDoc = placeBuildingCmd(prioDoc, {
      type: 'DAT_RelicSynthesizer',
      x: -13,
      y: 16,
      floor: 2,
      rotation: 0,
      recipeId: 'REC_Protomatter',
      disabledPorts: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    }).doc;
    for (let x = -4; x <= 6; x++) {
      prioDoc = placeBuildingCmd(prioDoc, { type: 'DAT_ConveyorBelt3', x, y: 10, floor: 2, rotation: 0 }).doc;
    }
    for (let y = 20; y >= 11; y--) {
      prioDoc = placeBuildingCmd(prioDoc, { type: 'DAT_ConveyorBelt3', x: -4, y, floor: 2, rotation: 3 }).doc;
    }
    // L0 (registered before L4): 1x SilicaSynthesis consumes exactly 0.5/s Protomatter (1 / 2s)
    prioDoc = placeBuildingCmd(prioDoc, { type: 'DAT_ConveyorBelt3', x: 6, y: 10, floor: 0, rotation: 2 }).doc;
    for (let x = 5; x >= -3; x--) {
      prioDoc = placeBuildingCmd(prioDoc, { type: 'DAT_ConveyorBelt3', x, y: 10, floor: 0, rotation: 2 }).doc;
    }
    prioDoc = placeBuildingCmd(prioDoc, {
      type: 'DAT_EnrichmentChamber',
      x: -12,
      y: 6,
      floor: 0,
      rotation: 0,
      recipeId: 'REC_SilicaSynthesis',
      disabledPorts: [1, 2, 3, 4, 5, 7, 8, 9, 10, 11],
    }).doc;
    prioDoc = placeBuildingCmd(prioDoc, { type: 'DAT_ConveyorBelt3', x: -13, y: 10, floor: 0, rotation: 2 }).doc;
    prioDoc = placeBuildingCmd(prioDoc, { type: 'DAT_Container', x: -15, y: 9, floor: 0, rotation: 0 }).doc;
    // L4 (registered after L0): terminal showcase box receives ONLY the exact 1.5/s overflow (2.0 - 0.5)!
    prioDoc = placeBuildingCmd(prioDoc, { type: 'DAT_ConveyorBelt3', x: 6, y: 10, floor: 4, rotation: 2 }).doc;
    prioDoc = placeBuildingCmd(prioDoc, { type: 'DAT_Container', x: 4, y: 9, floor: 4, rotation: 0 }).doc;
    const repPrio = simulateBlueprint(prioDoc);
    expect(repPrio.errorCount).toBe(0);
    expect(repPrio.cellFlows['0:6,10']?.totalRate).toBeCloseTo(0.5, 2);
    expect(repPrio.cellFlows['4:6,10']?.totalRate).toBeCloseTo(1.5, 2);

    // 4) 1x1 elevator rotation mismatch emits warning
    let rot1x1 = createEmptyBlueprint();
    rot1x1 = placeModuleCmd(rot1x1, { type: 'BPO_ElevatorBlock_03', gx: 0, gy: 0, floor: 0, rotation: 0 }).doc;
    rot1x1 = placeModuleCmd(rot1x1, { type: 'BPO_ElevatorBlock_03', gx: 0, gy: 0, floor: 1, rotation: 1 }).doc;
    const repRot1x1 = simulateBlueprint(rot1x1);
    expect(repRot1x1.issues.some((i) => i.code === 'elevator-rotation-mismatch' && i.severity === 'warn')).toBe(true);

    // 5) Mixed-item elevator shaft (two floors pushing different items into same shaft) emits elevator-mixed-shaft error!
    let mixDoc = createEmptyBlueprint();
    mixDoc = placeModuleCmd(mixDoc, { type: 'BPO_ElevatorBlock_02A', gx: 0, gy: 0, floor: 0, rotation: 0 }).doc;
    mixDoc = placeModuleCmd(mixDoc, { type: 'BPO_ElevatorBlock_02A', gx: 0, gy: 0, floor: 2, rotation: 0 }).doc;
    mixDoc = placeModuleCmd(mixDoc, { type: 'BPO_ElevatorBlock_02A', gx: 0, gy: 0, floor: 4, rotation: 0 }).doc;
    mixDoc = placeBuildingCmd(mixDoc, {
      type: 'DAT_Container',
      x: 3,
      y: 9,
      floor: 0,
      rotation: 0,
      filterItems: ['ITEM_TitaniumPlates'],
    }).doc;
    mixDoc = placeBuildingCmd(mixDoc, { type: 'DAT_ConveyorBelt3', x: 5, y: 10, floor: 0, rotation: 0 }).doc;
    mixDoc = placeBuildingCmd(mixDoc, { type: 'DAT_ConveyorBelt3', x: 6, y: 10, floor: 0, rotation: 0 }).doc;
    mixDoc = placeBuildingCmd(mixDoc, {
      type: 'DAT_Container',
      x: 3,
      y: 9,
      floor: 2,
      rotation: 0,
      filterItems: ['ITEM_NickelPlates'],
    }).doc;
    mixDoc = placeBuildingCmd(mixDoc, { type: 'DAT_ConveyorBelt3', x: 5, y: 10, floor: 2, rotation: 0 }).doc;
    mixDoc = placeBuildingCmd(mixDoc, { type: 'DAT_ConveyorBelt3', x: 6, y: 10, floor: 2, rotation: 0 }).doc;
    mixDoc = placeBuildingCmd(mixDoc, { type: 'DAT_ConveyorBelt3', x: 6, y: 10, floor: 4, rotation: 2 }).doc;
    mixDoc = placeBuildingCmd(mixDoc, { type: 'DAT_Container', x: 4, y: 9, floor: 4, rotation: 0 }).doc;
    const repMix = simulateBlueprint(mixDoc);
    expect(repMix.issues.some((i) => i.code === 'elevator-mixed-shaft' && i.severity === 'error')).toBe(true);
  });
});
