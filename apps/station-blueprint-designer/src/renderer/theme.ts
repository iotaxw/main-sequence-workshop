/**
 * Curated restrained architectural CAD themes.
 * Focus-layer primary & secondary ink colors are pre-baked over the dark obsidian base
 * so lines render at solid opacity = 1.0 (zero alpha-stacking vertex dots, crisp jewelry-like contrast).
 */

export type CadThemeId = 'platinum-gold' | 'obsidian-slate';

export interface CadThemePalette {
  id: CadThemeId;
  nameZh: string;
  // Scene backdrop & surfaces
  bg: number;
  slabFill: number;
  slabEdge: number;
  slabEdgeSelected: number;
  floorFill: number;
  floorBalconyFill: number;
  floorEdge: number;
  floorBalconyEdge: number;
  // Hidden-line architectural matte solids
  baseFill: number;
  baseFillSelected: number;
  bodyFill: number;
  bodyFillUpper: number;
  bodyFillSelected: number;
  // Pre-baked crisp ink lines (drawn at opacity 1.0 on focus floor!)
  linePrimary: number;
  lineDetail: number;
  lineSelected: number;
  // Logistics & belts
  beltTrackFill: number;
  beltRailMk1: number;
  beltRailMk2: number;
  beltRailMk3: number;
  beltArrow: number;
  // Archetype subtle mineral/metal accents
  researchTint: number;
  powerTint: number;
  armourTint: number;
  turretTint: number;
  solarTint: number;
  // Flush rectangular port slots
  portActiveLine: number;
  portDisabledLine: number;
  // Station connectors & technical overlays
  connLarge: number;
  connXLarge: number;
  connVertical: number;
  validGhost: number;
  invalidGhost: number;
  selectOutline: number;
  heightFrame: number;
  refAxis: number;
  undergroundLink: number;
  // Rounded floor grid shader colors
  gridLineHex: string;
  gridFillHex: string;
  // 3D top label ink
  labelTitleHex: string;
  labelSubHex: string;
}

export const CAD_THEMES: Record<CadThemeId, CadThemePalette> = {
  /**
   * 方案 A（默认）：曜石白金 + 拉丝香槟金（Obsidian Platinum & Champagne）
   * Deep pure obsidian void + crisp platinum-silver drafting ink + subtle brushed champagne-gold focal accents.
   */
  'platinum-gold': {
    id: 'platinum-gold',
    nameZh: '白金香槟',
    bg: 0x06080c,
    slabFill: 0x0b0f17,
    slabEdge: 0x323e4f,
    slabEdgeSelected: 0xd1b386,
    floorFill: 0x0f151f,
    floorBalconyFill: 0x131b28,
    floorEdge: 0x263244,
    floorBalconyEdge: 0x4f637c,
    baseFill: 0x0b1018,
    baseFillSelected: 0x161b24,
    bodyFill: 0x0d131d,
    bodyFillUpper: 0x111824,
    bodyFillSelected: 0x181e28,
    linePrimary: 0xcbd8e6,      // Crisp platinum-silver ink
    lineDetail: 0x3f4e62,       // Pre-baked quiet graphite ink (opacity 1.0 -> zero vertex dots!)
    lineSelected: 0xd4b689,     // Brushed champagne warm gold focal highlight
    beltTrackFill: 0x0c121b,
    beltRailMk1: 0x67798e,
    beltRailMk2: 0x99b1cb,
    beltRailMk3: 0xd4e0ec,
    beltArrow: 0x8ea6bf,
    researchTint: 0x7cb5b8,     // Refined cool mineral cyan
    powerTint: 0xc8a978,        // Brushed warm champagne gold
    armourTint: 0x8d9dae,       // Matte brushed titanium
    turretTint: 0xc29e74,       // Warm gunmetal-champagne
    solarTint: 0x779cb8,        // Photovoltaic slate-blue
    portActiveLine: 0x56ba88,   // Clean sage-emerald slot
    portDisabledLine: 0xa1494f, // Quiet muted crimson slot
    connLarge: 0x5c7592,
    connXLarge: 0x679499,
    connVertical: 0x9183b0,
    validGhost: 0xcfb286,       // Crisp champagne preview ghost
    invalidGhost: 0xc95a60,
    selectOutline: 0xd4b689,
    heightFrame: 0x283446,
    refAxis: 0x1b2534,
    undergroundLink: 0x627c99,
    gridLineHex: '#6c849f',
    gridFillHex: '#15202e',
    labelTitleHex: '#d4e0ec',
    labelSubHex: '#9c8c72',
  },

  /**
   * 保留原经典主题：暗调曜石银（Obsidian Slate）— 同样升级为无颗粒实墨锐利线条
   */
  'obsidian-slate': {
    id: 'obsidian-slate',
    nameZh: '曜石银灰',
    bg: 0x080b10,
    slabFill: 0x0c1119,
    slabEdge: 0x2c3a4e,
    slabEdgeSelected: 0xa6c4de,
    floorFill: 0x0f1620,
    floorBalconyFill: 0x121c29,
    floorEdge: 0x243142,
    floorBalconyEdge: 0x455d78,
    baseFill: 0x0c1119,
    baseFillSelected: 0x131d2b,
    bodyFill: 0x0d131d,
    bodyFillUpper: 0x101723,
    bodyFillSelected: 0x142030,
    linePrimary: 0x9fb5cc,
    lineDetail: 0x39495d,
    lineSelected: 0xc4ddf4,
    beltTrackFill: 0x0d141e,
    beltRailMk1: 0x576b82,
    beltRailMk2: 0x7f9db9,
    beltRailMk3: 0xb1c7dc,
    beltArrow: 0x86a0ba,
    researchTint: 0x6ea6aa,
    powerTint: 0xb09b62,
    armourTint: 0x7c90a6,
    turretTint: 0x9aaec2,
    solarTint: 0x688ba8,
    portActiveLine: 0x50a87b,
    portDisabledLine: 0x873d42,
    connLarge: 0x4e6882,
    connXLarge: 0x537c82,
    connVertical: 0x706791,
    validGhost: 0xa4c6e3,
    invalidGhost: 0xc95b61,
    selectOutline: 0xa6c4de,
    heightFrame: 0x243042,
    refAxis: 0x192332,
    undergroundLink: 0x536c85,
    gridLineHex: '#607a94',
    gridFillHex: '#162230',
    labelTitleHex: '#b9cde0',
    labelSubHex: '#7c94ae',
  },
};

const THEME_STORAGE_KEY = 'ms_cad_theme_v1';

export function loadSavedTheme(): CadThemeId {
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (v === 'platinum-gold' || v === 'obsidian-slate') return v;
  } catch {
    // ignore storage errors
  }
  return 'platinum-gold';
}

export function saveTheme(theme: CadThemeId): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // ignore storage errors
  }
}
