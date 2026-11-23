/**
 * Curated architectural CAD themes:
 * - 'platinum-gold'（白金香槟）: Deep obsidian backdrop + platinum-silver drafting ink + subtle champagne focal accents.
 * - 'stealth-cad'（工程白图）: Clean bright off-white engineering CAD / Visio / ArchiCAD drafting sheet that blends
 *   effortlessly into any office/technical environment from across the room!
 *
 * Focus-layer primary & secondary ink colors are pre-baked over the theme base so lines render at solid
 * opacity = 1.0 (zero alpha-stacking vertex dots, crisp drafting contrast).
 */

export type CadThemeId = 'platinum-gold' | 'stealth-cad';

export interface CadThemePalette {
  id: CadThemeId;
  nameZh: string;
  isLight: boolean;
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
  dockMatchHint: number;
  validGhost: number;
  invalidGhost: number;
  simWarnColor: number;
  simErrorColor: number;
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
   */
  'platinum-gold': {
    id: 'platinum-gold',
    nameZh: '白金香槟',
    isLight: false,
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
    lineDetail: 0x3f4e62,       // Pre-baked quiet graphite ink
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
    connLarge: 0x6b88a8,
    connXLarge: 0x6ea3a8,
    connVertical: 0x9788b8,
    dockMatchHint: 0x67d49c,
    validGhost: 0xcfb286,
    invalidGhost: 0xc95a60,
    simWarnColor: 0xf2b938,     // Crisp amber-yellow warning for raw-input entries & power alerts
    simErrorColor: 0xe3545c,    // High-clarity crimson for blocking anomalies
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
   * 办公伪装主题：工程白图（Stealth Engineering CAD / Visio Paper）
   * Pure matte off-white engineering sheet + crisp charcoal-graphite technical linework + understated steel-blue selection.
   * Zero sci-fi glow, zero vignette — looks 100% like AutoCAD / Visio / ArchiCAD from across the room!
   */
  'stealth-cad': {
    id: 'stealth-cad',
    nameZh: '工程白图',
    isLight: true,
    bg: 0xf1f3f6,
    slabFill: 0xe4e8ee,
    slabEdge: 0x929eae,
    slabEdgeSelected: 0x1c5aa6,
    floorFill: 0xfafbfd,
    floorBalconyFill: 0xedf1f6,
    floorEdge: 0xc2cbd6,
    floorBalconyEdge: 0x7d8c9e,
    baseFill: 0xf4f6f9,
    baseFillSelected: 0xe3ecf7,
    bodyFill: 0xf8f9fb,
    bodyFillUpper: 0xedf0f5,
    bodyFillSelected: 0xdfe9f5,
    linePrimary: 0x242d3a,      // Crisp technical charcoal drafting ink
    lineDetail: 0x96a1b0,       // Fine 2H drafting-pencil detail ink
    lineSelected: 0x1c5aa6,     // Plain engineering blueprint selection blue
    beltTrackFill: 0xe7ebf1,
    beltRailMk1: 0x768394,
    beltRailMk2: 0x4c5a6d,
    beltRailMk3: 0x1e2836,
    beltArrow: 0x5c6b7e,
    researchTint: 0x2a5f75,     // Muted technical teal-slate
    powerTint: 0x6e5a38,        // Muted technical ochre-bronze
    armourTint: 0x4a5566,       // Structural steel-gray
    turretTint: 0x5c4c42,       // Muted dark bronze-gray
    solarTint: 0x35587a,        // Muted engineering steel-blue
    portActiveLine: 0x257a4e,   // Technical drafting emerald
    portDisabledLine: 0xa63c44, // Technical drafting crimson
    connLarge: 0x4a6685,
    connXLarge: 0x2b6d75,
    connVertical: 0x5d4f82,
    dockMatchHint: 0x1f8252,
    validGhost: 0x1c5aa6,
    invalidGhost: 0xb53840,
    simWarnColor: 0xd48308,     // High-contrast engineering amber on light drafting paper
    simErrorColor: 0xc92a35,    // Technical drafting crimson error
    selectOutline: 0x1c5aa6,
    heightFrame: 0xbcc5d1,
    refAxis: 0xd6dce5,
    undergroundLink: 0x5d738d,
    gridLineHex: '#7d8c9f',
    gridFillHex: '#dde3ec',
    labelTitleHex: '#1f2836',
    labelSubHex: '#5a687a',
  },
};

const THEME_STORAGE_KEY = 'ms_cad_theme_v1';

export function loadSavedTheme(): CadThemeId {
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (v === 'platinum-gold' || v === 'stealth-cad') return v;
    if (v === 'obsidian-slate') return 'stealth-cad';
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
