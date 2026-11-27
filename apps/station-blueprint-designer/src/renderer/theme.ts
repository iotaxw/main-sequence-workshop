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
  nameEn: string;
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
  // Logistics & belts (Tier 4 belt variants + Tier 5 conveyor belts)
  beltTrackFill: number;
  beltRailMk1: number;
  beltRailMk2: number;
  beltRailMk3: number;
  beltArrow: number;
  logisticsNodeColor: number;
  undergroundNodeColor: number;
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
    nameEn: 'Obsidian Gold',
    isLight: false,
    bg: 0x06080c,
    slabFill: 0x090d14,
    slabEdge: 0x354459,
    slabEdgeSelected: 0xd4b689,
    floorFill: 0x0c121b,
    floorBalconyFill: 0x121a27,
    floorEdge: 0x222d3f,
    floorBalconyEdge: 0x4e637d,
    baseFill: 0x0e141f,
    baseFillSelected: 0x161b24,
    bodyFill: 0x131b28,
    bodyFillUpper: 0x1a2435,
    bodyFillSelected: 0x1c2432,
    linePrimary: 0xdce6f2,      // Crisp bright platinum-white building ink (highest contrast over belts)
    lineDetail: 0x45566d,       // Pre-baked quiet steel-graphite internal ink
    lineSelected: 0xd4b689,     // Brushed champagne warm gold focal highlight (selection only)
    beltTrackFill: 0x141d2b,    // Cool recessed steel-slate belt bed
    beltRailMk1: 0x70859c,      // Tier 1: cool muted steel
    beltRailMk2: 0xa3bbd4,      // Tier 2: cool silver-blue
    beltRailMk3: 0xdce7f3,      // Tier 3: crisp cool silver-white
    beltArrow: 0x9eb7d1,        // Cool silver directional chevrons
    logisticsNodeColor: 0xadc2d6,   // Splitters & balancers: whisper-subtle cool silver-blue tint
    undergroundNodeColor: 0x9abec6, // Underground hoods: muted frost-cyan tunnel tint
    researchTint: 0x76b8be,     // Refined cool mineral cyan
    powerTint: 0xc8a978,        // Brushed warm champagne gold (command/reactor accent)
    armourTint: 0x8e9fb3,       // Matte brushed titanium
    turretTint: 0xc29e74,       // Warm gunmetal-champagne
    solarTint: 0x6b9ac0,        // Photovoltaic cool slate-blue
    portActiveLine: 0x56ba88,   // Clean sage-emerald slot
    portDisabledLine: 0xa1494f, // Quiet muted crimson slot
    connLarge: 0x6b88a8,
    connXLarge: 0x6ea3a8,
    connVertical: 0x9689bd,
    dockMatchHint: 0x67d49c,
    validGhost: 0xcfb286,
    invalidGhost: 0xc95a60,
    simWarnColor: 0xf2b938,     // Crisp amber-yellow warning for raw-input entries & power alerts
    simErrorColor: 0xe3545c,    // High-clarity crimson for blocking anomalies
    selectOutline: 0xd4b689,
    heightFrame: 0x283446,
    refAxis: 0x192333,
    undergroundLink: 0x5c7c8e,
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
    nameEn: 'Drafting Light',
    isLight: true,
    bg: 0xeef1f5,
    slabFill: 0xe2e7ee,
    slabEdge: 0x8f9db0,
    slabEdgeSelected: 0x1c5aa6,
    floorFill: 0xf9fafc,
    floorBalconyFill: 0xecf0f6,
    floorEdge: 0xc5ced9,
    floorBalconyEdge: 0x76869b,
    baseFill: 0xf2f5f9,
    baseFillSelected: 0xe1eaf6,
    bodyFill: 0xf1f4f9,
    bodyFillUpper: 0xe6ecf4,
    bodyFillSelected: 0xdce7f4,
    linePrimary: 0x1b2432,      // Crisp technical charcoal drafting ink
    lineDetail: 0x8e9bab,       // Fine 2H drafting-pencil detail ink
    lineSelected: 0x1c5aa6,     // Plain engineering blueprint selection blue
    beltTrackFill: 0xe3e9f1,    // Clean recessed cool drafting track fill
    beltRailMk1: 0x768598,      // Tier 1: cool drafting steel-gray
    beltRailMk2: 0x4b5d73,      // Tier 2: deeper cool slate-blue
    beltRailMk3: 0x1f2b3a,      // Tier 3: crisp dark cool ink
    beltArrow: 0x5a6b80,        // Cool slate chevrons
    logisticsNodeColor: 0x46627c,   // Splitters & balancers: muted drafting slate-blue
    undergroundNodeColor: 0x3b6973, // Underground hoods: muted drafting slate-teal
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
    undergroundLink: 0x557485,
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
