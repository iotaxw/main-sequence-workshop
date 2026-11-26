import React, { useEffect, useRef } from 'react';
import { getItemName, getRecipeDef, getRecipeName } from '../core/catalog';
import { formatFloorTag, useI18n } from '../core/i18n';
import type { WorkbenchCheckReport, WorkbenchFaultCode } from '../core/workbench-check';

export interface CheckFocusTarget {
  id: string;
  floor: number;
  x: number;
  y: number;
  buildingId?: string;
  moduleId?: string;
}

interface SimulationPanelProps {
  open: boolean;
  report: WorkbenchCheckReport | null;
  activeIssueId?: string | null;
  showIoSpots: boolean;
  onToggleShowIoSpots: () => void;
  onClose: () => void;
  onFocusTarget: (target: CheckFocusTarget) => void;
}

const CODE_LABEL_ZH: Record<WorkbenchFaultCode, string> = {
  'invalid-catalog': '未知构件',
  'module-overlap': '模块重叠',
  'building-out-of-floor': '超出地板',
  'building-overlap': '建筑重叠',
  'invalid-recipe': '配方无效',
  'orphan-belt': '孤立废带',
  'dead-end-belt': '撞墙死路',
  'head-on-belt': '正面相撞',
  'unpaired-underground': '地下带断连',
  'port-mismatch': '端口错接',
  'disabled-port-input': '禁用口进料',
  'mixed-item-belt': '混料位',
  'elevator-stack-gap': '电梯断层',
  'elevator-rotation-mismatch': '电梯错向',
  'elevator-mixed-shaft': '井道混料',
  'machine-missing-input': '缺少原料',
  'machine-wrong-item': '机器错料',
  'machine-blocked-output': '出料未接',
};

const CODE_LABEL_EN: Record<WorkbenchFaultCode, string> = {
  'invalid-catalog': 'Unknown Type',
  'module-overlap': 'Module Overlap',
  'building-out-of-floor': 'Off Floor',
  'building-overlap': 'Overlap',
  'invalid-recipe': 'Bad Recipe',
  'orphan-belt': 'Orphan Belt',
  'dead-end-belt': 'Dead End',
  'head-on-belt': 'Head-on Belt',
  'unpaired-underground': 'Unpaired UG',
  'port-mismatch': 'Port Mismatch',
  'disabled-port-input': 'Disabled Port',
  'mixed-item-belt': 'Mixed Belt',
  'elevator-stack-gap': 'Shaft Gap',
  'elevator-rotation-mismatch': 'Shaft Twist',
  'elevator-mixed-shaft': 'Mixed Shaft',
  'machine-missing-input': 'Missing Input',
  'machine-wrong-item': 'Wrong Item',
  'machine-blocked-output': 'Blocked Out',
};

function fmtMW(mw: number): string {
  return Math.abs(mw) >= 100 ? mw.toFixed(0) : mw.toFixed(1);
}

export const SimulationPanel: React.FC<SimulationPanelProps> = React.memo(({
  open,
  report,
  activeIssueId,
  showIoSpots,
  onToggleShowIoSpots,
  onClose,
  onFocusTarget,
}) => {
  const { lang, isEn, t } = useI18n();
  const issueRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  useEffect(() => {
    if (!open || !activeIssueId) return;
    const el = issueRefs.current.get(activeIssueId);
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [open, activeIssueId]);

  if (!open || !report) return null;

  const codeLabels = isEn ? CODE_LABEL_EN : CODE_LABEL_ZH;
  const p = report.power;
  const hasGen = p.maxGenMW > 0;
  const netSign = p.netBalanceMW >= 0 ? '+' : '';
  const totalIo = report.ioSpots.length;

  const verdictText = !report.passed
    ? report.warnCount > 0
      ? isEn
        ? `${report.errorCount} errors · ${report.warnCount} warnings`
        : `${report.errorCount} 处错误 · ${report.warnCount} 项警告`
      : isEn
        ? `${report.errorCount} errors`
        : `${report.errorCount} 处错误`
    : report.warnCount > 0
      ? isEn
        ? `0 errors · ${report.warnCount} warnings`
        : `0 错误 · ${report.warnCount} 项警告`
      : t('0 异常 · 图纸通过', '0 issues · Passed');

  const powerSubParts: string[] = [];
  if (p.crafterPeakMW > 0) powerSubParts.push(`${t('产线', 'Craft')} ${fmtMW(p.crafterPeakMW)}`);
  if (p.labPeakMW > 0) powerSubParts.push(`${t('科研', 'Labs')} ${fmtMW(p.labPeakMW)}`);
  if (p.facilityPeakMW > 0) powerSubParts.push(`${t('设施', 'Fac')} ${fmtMW(p.facilityPeakMW)}`);
  if (p.intermittentPeakMW > 0) powerSubParts.push(`${t('炮塔', 'Turret')} ${fmtMW(p.intermittentPeakMW)}`);

  const genSubParts: string[] = [];
  if (p.solarGenMW > 0)
    genSubParts.push(`${t('光伏', 'Solar')} ${fmtMW(p.solarGenMW * 0.2)}~${fmtMW(p.solarGenMW)}`);
  if (p.reactorGenMW > 0) genSubParts.push(`${t('反应堆', 'Reactor')} ${fmtMW(p.reactorGenMW)}`);

  const beltUnit = t('带', 'B');

  return (
    <aside className="cad-sim-panel" aria-label={t('图纸体检', 'Blueprint Check')}>
      <div className="panel-header">
        <div className="panel-title-wrap">
          <span className="panel-tag">CHK</span>
          <span className="panel-title">{t('图纸体检', 'Blueprint Check')}</span>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} title={t('关闭 (Esc)', 'Close (Esc)')}>
          ×
        </button>
      </div>

      <div className="sim-body">
        <div className={`sim-verdict ${report.passed ? 'ok' : 'err'}`}>
          <span className="sim-verdict-dot" />
          <span>{verdictText}</span>
          <span className="sim-verdict-ms">{report.durationMs < 1 ? '<1' : Math.round(report.durationMs)}ms</span>
        </div>

        <div className="sim-kpi-grid">
          <div className="sim-kpi">
            <span className="sim-kpi-label">{t('配置机器', 'Machines')}</span>
            <strong className="sim-kpi-val">
              {report.configuredMachineCount}/{report.machineCount}
            </strong>
          </div>
          <div className="sim-kpi">
            <span className="sim-kpi-label">{t('额定峰值', 'Peak Load')}</span>
            <strong className="sim-kpi-val">{fmtMW(p.peakDrawMW)} MW</strong>
          </div>
          <div className="sim-kpi">
            <span className="sim-kpi-label">{t('发电容量', 'Power Gen')}</span>
            <strong
              className={`sim-kpi-val ${!hasGen ? '' : p.netBalanceMW >= 0 ? 'ok' : 'warn'}`}
            >
              {hasGen ? `${fmtMW(p.maxGenMW)} MW` : '0 MW'}
            </strong>
          </div>
        </div>

        {(p.peakDrawMW > 0 || hasGen) && (
          <div className="sim-power-bar">
            {powerSubParts.length > 0 && (
              <div className="sim-power-sub">{powerSubParts.join(' · ')} MW</div>
            )}
            <div className="sim-power-row">
              <span className="sim-kpi-label">
                {t('供电余量', 'Net Power')}
                {hasGen ? ` (${p.generatorCount})` : ''}
              </span>
              <strong className={`sim-power-val ${!hasGen ? '' : p.netBalanceMW >= 0 ? 'ok' : 'warn'}`}>
                {hasGen ? `${netSign}${fmtMW(p.netBalanceMW)} MW` : t('未配电站', 'No Gen')}
              </strong>
            </div>
            {genSubParts.length > 0 && (
              <div className="sim-power-sub">
                {genSubParts.join(' + ')} MW ({t('远日保底', 'Min')} {fmtMW(p.minGenMW)} MW)
              </div>
            )}
          </div>
        )}

        {report.ratedNetInputs.length > 0 && (
          <div className="sim-section">
            <div className="section-label">{t('满载净输入', 'Rated Net Inputs')}</div>
            <div className="sim-rate-list">
              {report.ratedNetInputs.map((item) => (
                <div key={item.itemId} className="sim-rate-row">
                  <span className="sim-rate-name">{getItemName(item.itemId, lang)}</span>
                  <span className="sim-rate-num">
                    {item.ratePerSec.toFixed(2)}/s · {item.beltsMk3.toFixed(2)}{beltUnit}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {report.ratedNetOutputs.length > 0 && (
          <div className="sim-section">
            <div className="section-label">{t('满载净输出', 'Rated Net Outputs')}</div>
            <div className="sim-rate-list">
              {report.ratedNetOutputs.map((item) => (
                <div key={item.itemId} className="sim-rate-row">
                  <span className="sim-rate-name">{getItemName(item.itemId, lang)}</span>
                  <span className="sim-rate-num out">
                    {item.ratePerSec.toFixed(2)}/s · {item.beltsMk3.toFixed(2)}{beltUnit}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {report.recipeSummary.length > 0 && (
          <div className="sim-section">
            <div className="section-label">{t('配方汇总', 'Recipes')}</div>
            <div className="sim-rate-list">
              {report.recipeSummary.map((rs) => {
                const rec = getRecipeDef(rs.recipeId);
                const rName = rec ? getRecipeName(rec, lang) : rs.recipeId;
                return (
                  <div key={rs.recipeId} className="sim-rate-row">
                    <span className="sim-rate-name">
                      {rName} ×{rs.machineCount}
                    </span>
                    <span className="sim-rate-num">
                      {rs.ratedOutputs.map((o) => `${o.ratePerSec.toFixed(2)}/s`).join(' + ')}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="sim-section">
          <div className="sim-section-head">
            <div className="section-label">
              {t(`问题列表 (${report.faults.length})`, `Issues (${report.faults.length})`)}
            </div>
            {totalIo > 0 && (
              <button
                type="button"
                className={`sim-io-toggle ${showIoSpots ? 'active' : ''}`}
                onClick={onToggleShowIoSpots}
                title={t('在画布与列表显示进出口点位', 'Toggle I/O boundary markers on canvas and list')}
              >
                {showIoSpots
                  ? t(`隐藏进出口 (${totalIo})`, `Hide I/O (${totalIo})`)
                  : t(`显示进出口 (${totalIo})`, `Show I/O (${totalIo})`)}
              </button>
            )}
          </div>
          {report.faults.length === 0 ? (
            <div className="sim-empty">{t('无异常', 'No issues')}</div>
          ) : (
            (() => {
              const activeIdx = activeIssueId ? report.faults.findIndex((i) => i.id === activeIssueId) : -1;
              const limit = activeIdx >= 80 ? activeIdx + 5 : 80;
              return (
                <div className="sim-issue-list">
                  {report.faults.slice(0, limit).map((issue) => (
                    <button
                      key={issue.id}
                      ref={(node) => {
                        if (node) issueRefs.current.set(issue.id, node);
                        else issueRefs.current.delete(issue.id);
                      }}
                      type="button"
                      className={`sim-issue-item ${issue.severity}${issue.id === activeIssueId ? ' active' : ''}`}
                      onClick={() => onFocusTarget(issue)}
                    >
                      <span className="sim-issue-badge">{codeLabels[issue.code]}</span>
                      <span className="sim-issue-msg">{issue.message}</span>
                      <span className="sim-issue-coord">
                        {formatFloorTag(issue.floor)} ({issue.x},{issue.y})
                      </span>
                    </button>
                  ))}
                  {report.faults.length > limit && (
                    <div className="sim-empty">
                      {isEn
                        ? `${report.faults.length - limit} more folded…`
                        : `其余 ${report.faults.length - limit} 条已折叠…`}
                    </div>
                  )}
                </div>
              );
            })()
          )}
        </div>

        {showIoSpots && report.ioSpots.length > 0 && (
          <div className="sim-section">
            <div className="section-label">
              {isEn
                ? `I/O Spots (${report.inputSpotCount} In / ${report.outputSpotCount} Out)`
                : `进出口点位 (${report.inputSpotCount} 进 / ${report.outputSpotCount} 出)`}
            </div>
            <div className="sim-issue-list">
              {report.ioSpots.slice(0, 80).map((spot) => (
                <button
                  key={spot.id}
                  ref={(node) => {
                    if (node) issueRefs.current.set(spot.id, node);
                    else issueRefs.current.delete(spot.id);
                  }}
                  type="button"
                  className={`sim-issue-item warn input-spot${spot.id === activeIssueId ? ' active' : ''}`}
                  onClick={() => onFocusTarget(spot)}
                >
                  <span className="sim-issue-badge">
                    {spot.direction === 'in' ? t('首·入口', 'In') : t('尾·出口', 'Out')}
                  </span>
                  <span className="sim-issue-msg">{spot.message}</span>
                  <span className="sim-issue-coord">
                    {formatFloorTag(spot.floor)} ({spot.x},{spot.y})
                  </span>
                </button>
              ))}
              {report.ioSpots.length > 80 && (
                <div className="sim-empty">
                  {isEn
                    ? `${report.ioSpots.length - 80} more folded…`
                    : `其余 ${report.ioSpots.length - 80} 条已折叠…`}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
});
