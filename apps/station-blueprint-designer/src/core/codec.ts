import { CATALOG, getBuildableDef, getModuleDef } from './catalog';
import { createEntityId } from './commands';
import type { BlueprintDocument, PlacedBuilding, PlacedModule, Rotation } from './types';

export const CURRENT_FORMAT = 'station-blueprint-designer' as const;
export const CURRENT_FORMAT_VERSION = 2 as const;

export interface DecodeResult {
  ok: true;
  doc: BlueprintDocument;
  warnings: string[];
}

export interface DecodeError {
  ok: false;
  error: string;
}

function isFiniteInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v);
}

function isRotation(v: unknown): v is Rotation {
  return v === 0 || v === 1 || v === 2 || v === 3;
}

export function serializeBlueprint(doc: BlueprintDocument): string {
  const payload: Record<string, unknown> = {
    ...(doc.extensions ?? {}),
    format: CURRENT_FORMAT,
    formatVersion: CURRENT_FORMAT_VERSION,
    id: doc.id,
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    gameData: doc.gameData,
    modules: doc.modules,
    buildings: doc.buildings,
  };
  return JSON.stringify(payload, null, 2) + '\n';
}

export function deserializeBlueprint(rawText: string): DecodeResult | DecodeError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, error: '蓝图文件不是合法的 JSON 格式。' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '蓝图根节点必须是 JSON 对象。' };
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.format !== CURRENT_FORMAT) {
    return { ok: false, error: `不支持的蓝图格式标识：${String(obj.format ?? '(空)')}。` };
  }

  const ver = obj.formatVersion;
  if (!isFiniteInt(ver) || ver < 1) {
    return { ok: false, error: '蓝图格式版本号无效。' };
  }
  if (ver > CURRENT_FORMAT_VERSION) {
    return {
      ok: false,
      error: `蓝图版本 v${ver} 高于当前应用支持的 v${CURRENT_FORMAT_VERSION}，已拒绝降级解析以保护原文件。`,
    };
  }

  const warnings: string[] = [];
  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : '未命名蓝图';
  const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : createEntityId('bp');
  const description = typeof obj.description === 'string' ? obj.description : undefined;

  const rawGameData = obj.gameData as Record<string, unknown> | undefined;
  const buildId = typeof rawGameData?.buildId === 'string' ? rawGameData.buildId : CATALOG.game.buildId;
  const catalogVersion = isFiniteInt(rawGameData?.catalogVersion) ? rawGameData.catalogVersion : CATALOG.catalogVersion;
  if (buildId !== CATALOG.game.buildId) {
    warnings.push(`蓝图记录的游戏 Build 为 ${buildId}，当前目录为 ${CATALOG.game.buildId}。`);
  }

  if (!Array.isArray(obj.modules)) {
    return { ok: false, error: '蓝图缺少有效的 modules 数组。' };
  }
  const rawBuildings = Array.isArray(obj.buildings) ? obj.buildings : Array.isArray(obj.buildables) ? obj.buildables : null;
  if (!rawBuildings) {
    return { ok: false, error: '蓝图缺少有效的 buildings 数组。' };
  }

  const modules: PlacedModule[] = [];
  const seenModIds = new Set<string>();
  for (let i = 0; i < obj.modules.length; i++) {
    const m = obj.modules[i] as Record<string, unknown>;
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') {
      return { ok: false, error: `modules[${i}] 结构无效。` };
    }
    // Support v1 [gx, gy, floor] tuple or v2 flat integer coords
    let gx: unknown = m.gx;
    let gy: unknown = m.gy;
    let floor: unknown = m.floor;
    if (Array.isArray(m.grid) && m.grid.length >= 3) {
      [gx, gy, floor] = m.grid;
    }
    if (!isFiniteInt(gx) || !isFiniteInt(gy) || !isFiniteInt(floor) || !isRotation(m.rotation)) {
      return { ok: false, error: `modules[${i}] 坐标或旋转角无效。` };
    }
    if (!getModuleDef(m.type)) {
      warnings.push(`包含未知空间站模块类型「${m.type}」，已原样保留。`);
    }
    const mid = typeof m.id === 'string' && m.id && !seenModIds.has(m.id) ? m.id : createEntityId('mod');
    seenModIds.add(mid);
    modules.push({
      id: mid,
      type: m.type,
      gx,
      gy,
      floor,
      rotation: m.rotation,
      ...(typeof m.label === 'string' && m.label ? { label: m.label } : {}),
    });
  }

  const buildings: PlacedBuilding[] = [];
  const seenBldIds = new Set<string>();
  for (let i = 0; i < rawBuildings.length; i++) {
    const b = rawBuildings[i] as Record<string, unknown>;
    if (!b || typeof b !== 'object' || typeof b.type !== 'string') {
      return { ok: false, error: `buildings[${i}] 结构无效。` };
    }
    if (!isFiniteInt(b.x) || !isFiniteInt(b.y) || !isFiniteInt(b.floor) || !isRotation(b.rotation)) {
      return { ok: false, error: `buildings[${i}] 坐标或旋转角无效。` };
    }
    if (!getBuildableDef(b.type)) {
      warnings.push(`包含未知建筑类型「${b.type}」，已原样保留。`);
    }
    const bid = typeof b.id === 'string' && b.id && !seenBldIds.has(b.id) ? b.id : createEntityId('bld');
    seenBldIds.add(bid);
    const disabledPorts = Array.isArray(b.disabledPorts)
      ? b.disabledPorts.filter((p): p is number => isFiniteInt(p) && p >= 0)
      : undefined;
    buildings.push({
      id: bid,
      type: b.type,
      x: b.x,
      y: b.y,
      floor: b.floor,
      rotation: b.rotation,
      ...(typeof b.recipeId === 'string' && b.recipeId ? { recipeId: b.recipeId } : {}),
      ...(typeof b.label === 'string' && b.label ? { label: b.label } : {}),
      ...(disabledPorts && disabledPorts.length > 0 ? { disabledPorts } : {}),
      ...(b.undergroundMode === 'in' || b.undergroundMode === 'out' ? { undergroundMode: b.undergroundMode } : {}),
    });
  }

  const knownKeys = new Set([
    'format', 'formatVersion', 'id', 'name', 'description',
    'gameData', 'modules', 'buildings', 'buildables',
  ]);
  const extensions: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!knownKeys.has(k)) extensions[k] = v;
  }

  return {
    ok: true,
    doc: {
      format: CURRENT_FORMAT,
      formatVersion: CURRENT_FORMAT_VERSION,
      id,
      name,
      ...(description ? { description } : {}),
      gameData: { buildId, catalogVersion },
      modules,
      buildings,
      ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
    },
    warnings,
  };
}

/** Build a clean, realistic starter showcase blueprint demonstrating 2x2 A, 2x2 B (with L+1 ring balcony), and machines/belts */
export function createStarterBlueprint(): BlueprintDocument {
  return {
    format: CURRENT_FORMAT,
    formatVersion: CURRENT_FORMAT_VERSION,
    id: 'bp_starter_demo',
    name: '示例 · 双层装配枢纽',
    description: '包含 2×2 A 首层产线、2×2 B（含二层回字形挑台）与 1×1 电梯井',
    gameData: {
      buildId: CATALOG.game.buildId,
      catalogVersion: CATALOG.catalogVersion,
    },
    modules: [
      { id: 'mod_a1', type: 'BPO_Station_02A', gx: 0, gy: 0, floor: 0, rotation: 0, label: '精炼与初级装配' },
      { id: 'mod_b1', type: 'BPO_Station_02', gx: 2, gy: 0, floor: 0, rotation: 0, label: '双层核心区' },
      { id: 'mod_e0', type: 'BPO_ElevatorBlock_03', gx: 0, gy: 2, floor: 0, rotation: 0, label: '物流电梯 L0' },
      { id: 'mod_e1', type: 'BPO_ElevatorBlock_03', gx: 0, gy: 2, floor: 1, rotation: 0, label: '物流电梯 L1' },
      { id: 'mod_a2', type: 'BPO_Station_02A', gx: 0, gy: 0, floor: 1, rotation: 0, label: '二层扩展甲板' },
    ],
    buildings: [
      // Refineries on 2x2 A (cells 1..30 x 1..30)
      { id: 'bld_ref1', type: 'DAT_Refinery', x: 5, y: 6, floor: 0, rotation: 0, recipeId: 'REC_TitaniumPlates', disabledPorts: [1, 3] },
      { id: 'bld_ref2', type: 'DAT_Refinery', x: 5, y: 12, floor: 0, rotation: 0, recipeId: 'REC_NickelPlates', disabledPorts: [1, 3] },
      // Belts from refineries to assembler
      { id: 'bld_b1', type: 'DAT_ConveyorBelt', x: 8, y: 7, floor: 0, rotation: 0 },
      { id: 'bld_b2', type: 'DAT_ConveyorBelt', x: 9, y: 7, floor: 0, rotation: 0 },
      { id: 'bld_b3', type: 'DAT_ConveyorBelt', x: 10, y: 7, floor: 0, rotation: 0 },
      { id: 'bld_b4', type: 'DAT_ConveyorBelt', x: 11, y: 7, floor: 0, rotation: 0 },
      { id: 'bld_b5', type: 'DAT_ConveyorBelt', x: 12, y: 7, floor: 0, rotation: 0 },
      { id: 'bld_b6', type: 'DAT_ConveyorBelt', x: 13, y: 7, floor: 0, rotation: 0 },
      { id: 'bld_b7', type: 'DAT_ConveyorBelt', x: 8, y: 13, floor: 0, rotation: 0 },
      { id: 'bld_b8', type: 'DAT_ConveyorBelt', x: 9, y: 13, floor: 0, rotation: 0 },
      { id: 'bld_b9', type: 'DAT_ConveyorBelt', x: 10, y: 13, floor: 0, rotation: 0 },
      { id: 'bld_b10', type: 'DAT_ConveyorBelt', x: 11, y: 13, floor: 0, rotation: 0 },
      { id: 'bld_b11', type: 'DAT_ConveyorBelt', x: 12, y: 13, floor: 0, rotation: 0 },
      { id: 'bld_b12', type: 'DAT_ConveyorBelt', x: 13, y: 13, floor: 0, rotation: 3 },
      { id: 'bld_b13', type: 'DAT_ConveyorBelt', x: 13, y: 12, floor: 0, rotation: 3 },
      { id: 'bld_b14', type: 'DAT_ConveyorBelt', x: 13, y: 11, floor: 0, rotation: 3 },
      { id: 'bld_b15', type: 'DAT_ConveyorBelt', x: 13, y: 10, floor: 0, rotation: 0 },
      // Assembler (5x5)
      { id: 'bld_asm1', type: 'DAT_Assembler', x: 14, y: 6, floor: 0, rotation: 0, recipeId: 'REC_HullPlates', disabledPorts: [2, 3, 6, 7] },
      // Belt crossing doorway from 2x2 A (x=31) into 2x2 B (x=32) at doorway y=7 (local y=-9 in [-11,-5])
      { id: 'bld_c1', type: 'DAT_ConveyorBelt2', x: 19, y: 7, floor: 0, rotation: 0 },
      { id: 'bld_c2', type: 'DAT_ConveyorBelt2', x: 20, y: 7, floor: 0, rotation: 0 },
      { id: 'bld_c3', type: 'DAT_ConveyorBelt2', x: 21, y: 7, floor: 0, rotation: 0 },
      { id: 'bld_c4', type: 'DAT_ConveyorBelt2', x: 22, y: 7, floor: 0, rotation: 0 },
      { id: 'bld_c5', type: 'DAT_ConveyorBelt2', x: 23, y: 7, floor: 0, rotation: 0 },
      { id: 'bld_c6', type: 'DAT_ConveyorBelt2', x: 24, y: 7, floor: 0, rotation: 0 },
      { id: 'bld_c7', type: 'DAT_ConveyorBelt2', x: 25, y: 7, floor: 0, rotation: 0 },
      { id: 'bld_c8', type: 'DAT_ConveyorBelt2', x: 26, y: 7, floor: 0, rotation: 0 },
      { id: 'bld_c9', type: 'DAT_ConveyorBelt2', x: 27, y: 7, floor: 0, rotation: 0 },
      { id: 'bld_c10', type: 'DAT_ConveyorBelt2', x: 28, y: 7, floor: 0, rotation: 0 },
      { id: 'bld_c11', type: 'DAT_ConveyorBelt2', x: 29, y: 7, floor: 0, rotation: 0 },
      { id: 'bld_c12', type: 'DAT_ConveyorBelt2', x: 30, y: 7, floor: 0, rotation: 0 },
      { id: 'bld_c13', type: 'DAT_ConveyorBelt2', x: 31, y: 7, floor: 0, rotation: 0 },
      { id: 'bld_c14', type: 'DAT_ConveyorBelt2', x: 32, y: 7, floor: 0, rotation: 0 },
      { id: 'bld_c15', type: 'DAT_ConveyorBelt2', x: 33, y: 7, floor: 0, rotation: 0 },
      { id: 'bld_c16', type: 'DAT_ConveyorBelt2', x: 34, y: 7, floor: 0, rotation: 0 },
      // Container inside 2x2 B
      { id: 'bld_cnt1', type: 'DAT_Container_2', x: 35, y: 6, floor: 0, rotation: 0, label: '成品缓冲仓' },
      // L+1 ring balcony belt + 3x3 Refinery on 2x2 B upper floor! (gx=2 -> center 48,16 -> ring x in [33..35])
      { id: 'bld_bal_ref', type: 'DAT_Refinery', x: 33, y: 6, floor: 1, rotation: 0, recipeId: 'REC_SiliconWafers', label: '挑台精炼' },
      { id: 'bld_bal_b1', type: 'DAT_ConveyorBelt', x: 31, y: 7, floor: 1, rotation: 0 },
      { id: 'bld_bal_b2', type: 'DAT_ConveyorBelt', x: 32, y: 7, floor: 1, rotation: 0 },
    ],
  };
}
