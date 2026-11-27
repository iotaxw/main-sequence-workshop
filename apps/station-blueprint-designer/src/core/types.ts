export type Rotation = 0 | 1 | 2 | 3; // 0=+X(E), 1=+Y(S), 2=-X(W), 3=-Y(N)
export type CardinalSide = 'E' | 'S' | 'W' | 'N';
export type ViewMode = 'station' | 'building';
export type SelectionLayerMode = 'focus' | 'visible' | 'all';
export type BlueprintCategory = 'station' | 'ship';

export interface StationConnectorDef {
  type: 'Large' | 'XLarge' | 'LargeSide' | 'Vertical1x1' | 'Vertical2x2' | string;
  gx: number; // native half-unit (1 station unit = 16m = 4 native units -> 1 native unit = 4m)
  gy: number;
  floorOffset: number; // 0 or 1
  rotation: Rotation;
}

export interface DoorwaySpan {
  side: CardinalSide;
  start: number; // meters along edge relative to module center
  end: number;
}

export interface StationFloorSurfaceDef {
  floorOffset: number;
  shape: 'rect' | 'ring' | 'corner-ws';
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  holeMinX?: number;
  holeMaxX?: number;
  holeMinY?: number;
  holeMaxY?: number;
  doorways: DoorwaySpan[];
  elevatorPorts?: Array<{ x: number; y: number }>;
  note?: string;
}

export type ShipPowerRole =
  | 'generator'
  | 'thruster'
  | 'shield'
  | 'weapon'
  | 'mining'
  | 'workstation'
  | 'other'
  | 'none';

export interface ShipModuleExtraStats {
  shieldCapacity?: number;
  shieldRecharge?: number;
  rangeM?: number;
  damagePerShot?: number;
  damagePerSec?: number;
  energyPerShotMJ?: number;
  missileSilos?: number;
  reloadSec?: number;
  warpSpeedMS?: number;
  interstellarWarp?: boolean;
  stackBonusPct?: number;
  tractorRangeM?: number;
}

export interface StationModuleDef {
  id: string;
  /** Runtime domain tagged by catalog loader ('station' | 'ship'). */
  domain?: BlueprintCategory;
  nameEn: string;
  nameZh: string;
  descriptionZh: string;
  categoryEn: string;
  categoryZh: string;
  sizeUnits: [number, number, number]; // [widthUnits, depthUnits, floorSpan] (station: 16m/8m, ship: 8m/4m)
  blockBoundsM: {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
  } | null;
  /** Verified Build 26639889 primary StaticMesh 3D vertex bounds in meters */
  meshBoundsM?: {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
  };
  heightSpanM: number;
  canRotate: boolean;
  /** Native MirrorClass partner ID (toggled by F in native designer) */
  mirrorId?: string;
  isMirrorVariant?: boolean;
  /** Native FunctionalType (e.g. PilotBlock, DockingCollar, WarpDrive, hangar) */
  functionalType?: string;
  connectors: StationConnectorDef[];
  hasFactoryFloor: boolean;
  floors: StationFloorSurfaceDef[];
  /** Verified Build 26639889 ship mass in tonnes */
  weightT?: number;
  /** Verified Build 26639889 ship hull durability points */
  hull?: number;
  /** Verified Build 26639889 normal thruster output in kN */
  thrustKN?: number;
  /** Verified Build 26639889 boosting thruster output in kN */
  boostThrustKN?: number;
  /** Verified Build 26639889 steady/peak power consumption in kW (1000 kW = 1 MW) */
  powerKW?: number;
  /** Verified Build 26639889 maximum power generation in kW (e.g. Solar Panels / Ship Reactor) */
  powerGenKW?: number;
  powerRole?: ShipPowerRole;
  shipStats?: ShipModuleExtraStats;
  sourceAsset: string;
}

export type BuildableKind =
  | 'crafter'
  | 'research'
  | 'reactor'
  | 'workbench'
  | 'teleporter'
  | 'belt'
  | 'underground'
  | 'splitter'
  | 'balancer'
  | 'container'
  | 'sign'
  | 'decoration';

export interface MachinePortDef {
  index: number;
  hx: number; // half-meter offset from building center
  hy: number;
  side: CardinalSide;
  role: 'bi' | 'in' | 'out';
}

export interface BuildableDef {
  id: string;
  objectClass: string;
  nameEn: string;
  nameZh: string;
  descriptionZh: string;
  categoryEn: string;
  categoryZh: string;
  kind: BuildableKind;
  tier: 1 | 2 | 3;
  size: [number, number]; // real 1m integer footprint [w, d]
  heightM: number;
  crafterId: string | null;
  ports: MachinePortDef[];
  configurablePorts: boolean;
  maxLength?: number;
  powerKW?: number;
  powerGenKW?: number;
  sourceAsset: string;
}

export interface RecipeDef {
  id: string;
  crafterId: string;
  nameEn: string;
  nameZh: string;
  shortCode: string;
  durationSeconds?: number;
  inputs: Array<{ itemId: string; nameZh: string; quantity?: number }>;
  outputs: Array<{ itemId: string; nameZh: string; quantity?: number; isByproduct?: boolean }>;
}

export interface GameCatalog {
  catalogVersion: number;
  game: {
    id: string;
    buildId: string;
    engineVersion: string;
    extractedAt: string;
    source: string;
  };
  stationModules: StationModuleDef[];
  shipModules?: StationModuleDef[];
  buildables: BuildableDef[];
  recipes: RecipeDef[];
}

/** Placed station module on the 16m × 16m × 8m station grid */
export interface PlacedModule {
  id: string;
  type: string; // StationModuleDef.id
  gx: number; // integer 16m station grid min-X corner
  gy: number; // integer 16m station grid min-Y corner
  floor: number; // integer station floor L (each floor = 8m)
  rotation: Rotation;
  label?: string;
  /** Optional recipe for functional station modules with built-in machines (e.g. BPO_DeepSpaceObservatory) */
  recipeId?: string;
  /** Optional per-port filter config for BPO_Dock_2 (matches Build 26639889 BPO_IndustrialDock::Filters[8]) */
  dockPorts?: Array<{ portIndex: number; itemId: string; mode: 'unload' | 'load' }>;
  /** Optional native paint palette index (0 = default) */
  paletteId?: number;
  /** Optional native mining drone bay target ore itemId */
  miningItem?: string;
  /** Optional native dock / shipyard display name */
  dockName?: string;
  /** Lossless native DesignSaveGame metadata preserved across .sav round-trips */
  nativeMeta?: Record<string, unknown>;
}

/** Placed building/machine/belt on the unified 1m world grid, aligned with station floor L */
export interface PlacedBuilding {
  id: string;
  type: string; // BuildableDef.id
  x: number; // integer 1m cell min-X of rotated footprint
  y: number; // integer 1m cell min-Y of rotated footprint
  floor: number; // integer station floor L
  rotation: Rotation;
  recipeId?: string;
  label?: string;
  /** Disabled port indices (matching BuildableDef.ports[i].index); absent = all enabled */
  disabledPorts?: number[];
  /** Underground belt role when placed as entry/exit */
  undergroundMode?: 'in' | 'out';
  /** Explicit encoded partner building ID for underground in/out pairs (supports parallel/braided same-line runs) */
  undergroundPartnerId?: string;
  /** Prioritized input port index (e.g. Belt Balancer input lane 0 or 1) */
  priorityIn?: number;
  /** Prioritized output port index (e.g. Splitter output 1/2/3 or Balancer output 2/3) */
  priorityOut?: number;
  /** Per-port item filter mapping: portIndex -> itemId (Splitter / Balancer outputs) */
  portFilters?: Record<number, string>;
  /** Container logistic item filter whitelist (WBP_LogisticFilters) */
  filterItems?: string[];
  /** Optional native paint palette index */
  paletteId?: number;
  /** Lossless native DesignSaveGame metadata preserved across .sav round-trips */
  nativeMeta?: Record<string, unknown>;
}

/** Unified Blueprint Document (Scheme A: can be opened as workspace OR stamped as sub-blueprint!) */
export interface BlueprintDocument {
  format: 'station-blueprint-designer';
  formatVersion: 2;
  /** Blueprint carrier type (omitted defaults to 'station' for full backward compatibility) */
  category?: BlueprintCategory;
  id: string;
  name: string;
  description?: string;
  gameData: {
    buildId: string;
    catalogVersion: number;
  };
  modules: PlacedModule[];
  buildings: PlacedBuilding[];
  /** Lossless native DesignSaveGame document metadata (palettes, camera, GVAS header) */
  nativeMeta?: Record<string, unknown>;
  /** Preserve unknown extra fields on round-trip */
  extensions?: Record<string, unknown>;
}

export interface SelectionState {
  moduleIds: string[];
  buildingIds: string[];
}

export type ActiveTool =
  | { kind: 'select' }
  | { kind: 'demolish' }
  | { kind: 'place-module'; moduleType: string; rotation: Rotation; label?: string }
  | {
      kind: 'place-building';
      buildingType: string;
      rotation: Rotation;
      undergroundMode?: 'in' | 'out';
      pendingUndergroundInId?: string;
      recipeId?: string;
      label?: string;
      disabledPorts?: number[];
      priorityIn?: number;
      priorityOut?: number;
      portFilters?: Record<number, string>;
      filterItems?: string[];
    }
  | {
      kind: 'stamp-blueprint';
      blueprint: BlueprintDocument;
      name: string;
      rotation: Rotation;
      floorOffset: number;
      fromCut?: boolean;
    };

export interface LibraryFileEntry {
  kind: 'file';
  path: string; // posix relative path e.g. "production/circuits.json"
  name: string;
  fileName: string;
  blueprintName: string;
  category?: BlueprintCategory;
  moduleCount: number;
  buildingCount: number;
  totalWeightT?: number;
  floorSpan: number;
  updatedAt: number;
  /** Optional remote blob SHA / revision tag so cache invalidates accurately on cloud refresh/save */
  contentHash?: string;
}

export interface LibraryFolderEntry {
  kind: 'folder';
  path: string; // posix relative path e.g. "production"
  name: string;
  children: LibraryNode[];
}

export type LibraryNode = LibraryFolderEntry | LibraryFileEntry;

export interface PlacementIssue {
  kind: 'module-overlap' | 'building-overlap' | 'no-floor' | 'unknown-type';
  message: string;
  cells?: Array<[number, number]>;
}
