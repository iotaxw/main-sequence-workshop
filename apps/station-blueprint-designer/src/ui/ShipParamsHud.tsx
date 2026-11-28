import React, { useState } from 'react';
import { useI18n } from '../core/i18n';
import type { ShipPowerBucket, ShipStatsReport } from '../core/ship-stats';

interface ShipParamsHudProps {
  stats: ShipStatsReport;
  mobile?: boolean;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

function fmtNum(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

const ROLE_LABELS: Record<ShipPowerBucket['role'], { zh: string; en: string }> = {
  thruster: { zh: '推进器', en: 'Thrusters' },
  shield: { zh: '护盾', en: 'Shields' },
  weapon: { zh: '武器', en: 'Weapons' },
  mining: { zh: '采矿', en: 'Mining' },
  workstation: { zh: '工作站', en: 'Workstation' },
  other: { zh: '其它', en: 'Other' },
};

/**
 * Compact always-on Ship Parameters HUD (replaces Check panel & Inspector sidebar in Ship mode).
 * Displays verified Build 26639889 Mass / Thrust / Hull / Actual & Boost Speed / Warp Speed,
 * itemized Power generation vs operating-range consumption table, and stateful system summary.
 */
export const ShipParamsHud: React.FC<ShipParamsHudProps> = ({
  stats,
  mobile = false,
  mobileOpen = false,
  onMobileClose,
}) => {
  const { isEn, t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);

  if (mobile && !mobileOpen) return null;

  const p = stats.power;
  const sys = stats.systems;
  const powerTone =
    p.status === 'cruise-deficit' || p.status === 'no-power'
      ? 'err'
      : p.status === 'peak-warn'
        ? 'warn'
        : p.status === 'surplus'
          ? 'ok'
          : 'idle';

  const powerStatusText =
    p.status === 'no-power'
      ? t('无电源', 'No Power')
      : p.status === 'cruise-deficit'
        ? t('推进亏电 · 限10m/s', 'Low Pwr · 10m/s cap')
        : p.status === 'peak-warn'
          ? t('峰值亏电', 'Peak Deficit')
          : p.status === 'surplus'
            ? t('充裕', 'Surplus')
            : t('待机', 'Idle');

  const tierTag =
    stats.shipyardTier === 't1'
      ? 'T1 ≤100t'
      : stats.shipyardTier === 't2'
        ? 'T2 ≤400t'
        : 'T2+ >400t';

  // Stateful system chips (omit stateless parts like cockpit/workstation/docking collar unless alerted)
  const equipChips: Array<{ label: string; value: string }> = [];
  if (sys.shieldCapacity > 0) {
    equipChips.push({
      label: t('护盾', 'Shield'),
      value: `${sys.shieldCapacity} (+${fmtNum(sys.shieldRecharge)}/s)`,
    });
  }
  if (sys.containerCount > 0) {
    equipChips.push({
      label: t('货容', 'Cargo'),
      value: `+${sys.stackBonusPct}%`,
    });
  }
  if (sys.plasmaCannons > 0) {
    equipChips.push({ label: t('等离子炮', 'Cannon'), value: `×${sys.plasmaCannons}` });
  }
  if (sys.plasmaLances > 0) {
    equipChips.push({ label: t('长枪', 'Lance'), value: `×${sys.plasmaLances}` });
  }
  if (sys.missileSilos > 0) {
    equipChips.push({ label: t('导弹井', 'Silos'), value: `${sys.missileSilos}` });
  }
  if (sys.pointDefences > 0) {
    equipChips.push({ label: t('点防御', 'PD'), value: `×${sys.pointDefences}` });
  }
  if (sys.miningLasers > 0) {
    equipChips.push({ label: t('采矿光', 'Mining'), value: `×${sys.miningLasers}` });
  }
  if (sys.tractorBeams > 0) {
    equipChips.push({ label: t('牵引束', 'Tractor'), value: `×${sys.tractorBeams}` });
  }
  if (sys.hangars > 0) {
    equipChips.push({ label: t('机库', 'Hangar'), value: `×${sys.hangars}` });
  }
  if (sys.scanners > 0) {
    equipChips.push({ label: t('扫描', 'Scanner'), value: `×${sys.scanners}` });
  }
  if (sys.bioCollectors > 0) {
    equipChips.push({ label: t('采样', 'BioCol'), value: `×${sys.bioCollectors}` });
  }

  const effectiveCollapsed = mobile ? false : collapsed;

  return (
    <aside
      className={`ship-hud ${effectiveCollapsed ? 'collapsed' : ''} ${mobile ? 'mobile-sheet' : ''}`}
      aria-label={t('飞船参数', 'Ship Parameters')}
    >
      <button
        type="button"
        className="ship-hud-head"
        onClick={() => (mobile ? onMobileClose?.() : setCollapsed((v) => !v))}
        aria-expanded={!effectiveCollapsed}
      >
        <span className="ship-hud-title">
          {effectiveCollapsed ? (
            <span className="ship-hud-mini-line">
              <span>{fmtNum(stats.totalWeightT)}t</span>
              <span className="ship-hud-sep">·</span>
              <span>{fmtNum(stats.totalThrustKN)}kN</span>
              <span className="ship-hud-sep">·</span>
              <span>
                {stats.maxSpeedMS > 0 ? `${Math.round(stats.maxSpeedMS)}/${Math.round(stats.boostSpeedMS)}m/s` : '0m/s'}
              </span>
              <span className="ship-hud-sep">·</span>
              <span className={`ship-hud-tone ${powerTone}`}>
                {fmtNum(p.genMW)}/{fmtNum(p.peakMaxMW)}MW
              </span>
            </span>
          ) : (
            <>
              <span>{t('飞船参数', 'Ship Specs')}</span>
              <span className="ship-hud-tier">{tierTag}</span>
            </>
          )}
        </span>
        <span className="ship-hud-chevron" aria-hidden="true">
          {mobile ? '×' : effectiveCollapsed ? '▾' : '▴'}
        </span>
      </button>

      {!effectiveCollapsed && (
        <div className="ship-hud-body">
          {/* Section 1: Core Flight Performance */}
          <div className="ship-hud-grid">
            <div className="ship-hud-metric">
              <span className="ship-hud-k">{t('重量', 'Mass')}</span>
              <span className="ship-hud-v">{fmtNum(stats.totalWeightT)} t</span>
            </div>
            <div className="ship-hud-metric">
              <span className="ship-hud-k">{t('推力', 'Thrust')}</span>
              <span className="ship-hud-v">{fmtNum(stats.totalThrustKN)} kN</span>
            </div>
            <div className="ship-hud-metric">
              <span className="ship-hud-k">{t('结构', 'Hull')}</span>
              <span className="ship-hud-v">{fmtNum(stats.totalHull)}</span>
            </div>
            <div className="ship-hud-metric">
              <span className="ship-hud-k">{t('实际速度', 'Speed')}</span>
              <span className="ship-hud-v">
                {stats.maxSpeedMS > 0 ? `${fmtNum(stats.maxSpeedMS)} m/s` : '—'}
              </span>
            </div>
            <div className="ship-hud-metric">
              <span className="ship-hud-k">{t('加力速度', 'Boost')}</span>
              <span className={`ship-hud-v ${p.status === 'cruise-deficit' || p.status === 'no-power' ? 'tone-dim' : ''}`}>
                {stats.boostSpeedMS > 0 ? `${fmtNum(stats.boostSpeedMS)} m/s` : '—'}
              </span>
            </div>
            <div className="ship-hud-metric">
              <span className="ship-hud-k">{t('曲速', 'Warp')}</span>
              <span className="ship-hud-v">
                {stats.warp.hasWarp
                  ? `${stats.warp.interstellar ? t('星际 ', 'Star ') : ''}${stats.warp.warpSpeedMS} m/s`
                  : '—'}
              </span>
            </div>
          </div>

          {/* Section 2: Power Generation & Operating-Range Consumption Table */}
          <div className="ship-hud-section">
            <div className="ship-hud-sec-head">
              <span>{t('电力', 'Power')}</span>
              <span className={`ship-hud-badge ${powerTone}`}>{powerStatusText}</span>
            </div>
            <div className="ship-hud-table">
              <div className="ship-hud-row gen">
                <span>
                  {t('发电', 'Gen')}
                  {sys.reactorCount > 0 ? ` · ${t('堆', 'Rx')}×${sys.reactorCount}` : ''}
                </span>
                <span className="mono">+{fmtNum(p.genMW)} MW</span>
              </div>
              {p.buckets.map((b) => (
                <div key={b.role} className="ship-hud-row">
                  <span>
                    {isEn ? ROLE_LABELS[b.role].en : ROLE_LABELS[b.role].zh} ×{b.count}
                  </span>
                  <span className="mono">
                    {fmtNum(b.minMW)}–{fmtNum(b.maxMW)} MW
                  </span>
                </div>
              ))}
              {p.buckets.length > 0 && (
                <div className="ship-hud-row total">
                  <span>{t('总耗电范围', 'Total Draw')}</span>
                  <span className={`mono ship-hud-tone ${powerTone}`}>
                    0–{fmtNum(p.peakMaxMW)} MW
                  </span>
                </div>
              )}
              {p.buckets.length === 0 && (
                <div className="ship-hud-row muted">
                  <span>{t('耗电', 'Draw')}</span>
                  <span className="mono">0 MW</span>
                </div>
              )}
            </div>
          </div>

          {/* Section 3: Stateful Equipment Summary (only non-zero entries) */}
          {equipChips.length > 0 && (
            <div className="ship-hud-section">
              <div className="ship-hud-sec-head">
                <span>{t('装备', 'Systems')}</span>
              </div>
              <div className="ship-hud-chips">
                {equipChips.map((c) => (
                  <span key={c.label} className="ship-hud-chip">
                    <span className="ship-hud-chip-k">{c.label}</span>
                    <span className="ship-hud-chip-v">{c.value}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Section 4: Hard validation alerts only when triggered */}
          {stats.alerts.length > 0 && (
            <div className="ship-hud-alerts">
              {stats.alerts.map((a) => (
                <span key={a.code} className={`ship-hud-alert ${a.severity}`}>
                  {isEn ? a.en : a.zh}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  );
};
