export type Rotation = 0 | 1 | 2 | 3; // 0=+X(E), 1=+Y(S), 2=-X(W), 3=-Y(N)
export type CardinalSide = 'E' | 'S' | 'W' | 'N';
export type ViewMode = 'station' | 'building';
export type SelectionLayerMode = 'focus' | 'visible' | 'all';

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

export interface StationModuleDef {
  id: string;
  nameEn: string;
  nameZh: string;
  descriptionZh: string;
  categoryEn: string;
  categoryZh: string;
  sizeUnits: [number, number, number]; // [width16m, depth16m, floorSpan]
  blockBoundsM: {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
  } | null;
  heightSpanM: number;
  canRotate: boolean;
  connectors: StationConnectorDef[];
  hasFactoryFloor: boolean;
  floors: StationFloorSurfaceDef[];
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
  /** Prioritized input port index (e.g. Belt Balancer input lane 0 or 1) */
  priorityIn?: number;
  /** Prioritized output port index (e.g. Splitter output 1/2/3 or Balancer output 2/3) */
  priorityOut?: number;
  /** Per-port item filter mapping: portIndex -> itemId (Splitter / Balancer outputs) */
  portFilters?: Record<number, string>;
  /** Container logistic item filter whitelist (WBP_LogisticFilters) */
  filterItems?: string[];
}

/** Unified Blueprint Document (Scheme A: can be opened as workspace OR stamped as sub-blueprint!) */
export interface BlueprintDocument {
  format: 'station-blueprint-designer';
  formatVersion: 2;
  id: string;
  name: string;
  description?: string;
  gameData: {
    buildId: string;
    catalogVersion: number;
  };
  modules: PlacedModule[];
  buildings: PlacedBuilding[];
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
      recipeId?: string;
      label?: string;
      disabledPorts?: number[];
      priorityIn?: number;
      priorityOut?: number;
      portFilters?: Record<number, string>;
      filterItems?: string[];
    }
  | { kind: 'stamp-blueprint'; blueprint: BlueprintDocument; name: string; rotation: Rotation; floorOffset: number };

export interface LibraryFileEntry {
  kind: 'file';
  path: string; // posix relative path e.g. "production/circuits.json"
  name: string;
  fileName: string;
  blueprintName: string;
  moduleCount: number;
  buildingCount: number;
  floorSpan: number;
  updatedAt: number;
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
