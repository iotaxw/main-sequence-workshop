import React, { useEffect, useRef } from 'react';
import { getItemName, getRecipeDef, getRecipeName } from '../core/catalog';
import { formatFloorTag, useI18n } from '../core/i18n';
import type { SimulationIssue, SimulationReport } from '../core/simulation';

interface SimulationPanelProps {
  open: boolean;
  report: SimulationReport | null;
  activeIssueId?: string | null;
  onClose: () => void;
  onFocusIssue: (issue: SimulationIssue) => void;
}

const CODE_LABEL_ZH: Record<SimulationIssue['code'], string> = {
  'external-input-needed': '首·需入原料',
  'blueprint-output': '尾·产线出口',
  'disabled-port-input': '禁用口进料',
  'power-deficit': '供电偏紧',
  'orphan-belt': '孤立废带',
  'dead-end-belt': '撞墙死路',
  'head-on-belt': '正面相撞',
  'unpaired-underground': '地下带断连',
  'splitter-leak': '分流侧漏',
  'port-mismatch': '端口错接',
  'mixed-item-belt': '混料位',
  'belt-overload': '传送超载',
  'elevator-stack-gap': '电梯断层',
  'elevator-rotation-mismatch': '电梯错向',
  'elevator-mixed-shaft': '井道混料',
  'machine-missing-input': '机器缺料',
  'machine-wrong-item': '机器错料',
  'machine-blocked-output': '出料未接',
};

const CODE_LABEL_EN: Record<SimulationIssue['code'], string> = {
  'external-input-needed': 'Input Spot',
  'blueprint-output': 'Output Spot',
  'disabled-port-input': 'Disabled Port',
  'power-deficit': 'Power Tight',
  'orphan-belt': 'Orphan Belt',
  'dead-end-belt': 'Dead End',
  'head-on-belt': 'Head-on Belt',
  'unpaired-underground': 'Unpaired UG',
  'splitter-leak': 'Splitter Leak',
  'port-mismatch': 'Port Mismatch',
  'mixed-item-belt': 'Mixed Belt',
  'belt-overload': 'Belt Overload',
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

export const SimulationPanel: React.FC<SimulationPanelProps> = ({
  open,
  report,
  activeIssueId,
  onClose,
  onFocusIssue,
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
  const effText =
    report.configuredMachineCount > 0 ? `${Math.round(report.avgEfficiency * 1000) / 10}%` : '—';
  const inputSpotCount = report.externalInputs.length;
  const outputSpotCount = report.externalOutputs.length;
  const p = report.power;
  const hasGen = p.maxGenMW > 0;
  const netSign = p.netBalanceMW >= 0 ? '+' : '';

  const ioText =
    inputSpotCount > 0 || outputSpotCount > 0
      ? isEn
        ? `${inputSpotCount} In / ${outputSpotCount} Out`
        : `${inputSpotCount} 进 / ${outputSpotCount} 出`
      : '';
  const verdictText = !report.passed
    ? isEn
      ? `${report.errorCount} faults${ioText ? ` · ${ioText}` : ''}`
      : `${report.errorCount} 处故障${ioText ? ` · ${ioText}` : ''}`
    : report.anomalyWarnCount === 0
      ? ioText
        ? isEn
          ? `0 faults · ${ioText}`
          : `0 故障 · ${ioText}`
        : t('0 故障 · 产线畅通', '0 faults · Clean')
      : isEn
        ? `0 faults · ${report.anomalyWarnCount} warnings${ioText ? ` · ${ioText}` : ''}`
        : `0 故障 · ${report.anomalyWarnCount} 项预警${ioText ? ` · ${ioText}` : ''}`;

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
    <aside className="cad-sim-panel" aria-label={t('产线诊断', 'Line Diagnostics')}>
      <div className="panel-header">
        <div className="panel-title-wrap">
          <span className="panel-tag">SIM</span>
          <span className="panel-title">{t('产线诊断', 'Diagnostics')}</span>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} title={t('关闭 (Esc)', 'Close (Esc)')}>
          ×
        </button>
      </div>

      <div className="sim-body">
        <div className={`sim-verdict ${report.passed ? 'ok' : 'err'}`}>
          <span className="sim-verdict-dot" />
          <span>{verdictText}</span>
        </div>

        <div className="sim-kpi-grid">
          <div className="sim-kpi">
            <span className="sim-kpi-label">{t('拓扑效率', 'Efficiency')}</span>
            <strong className="sim-kpi-val">{effText}</strong>
          </div>
          <div className="sim-kpi">
            <span className="sim-kpi-label">{t('配置机器', 'Machines')}</span>
            <strong className="sim-kpi-val">
              {report.configuredMachineCount}/{report.machineCount}
            </strong>
          </div>
          <div className="sim-kpi">
            <span className="sim-kpi-label">{t('首 / 尾口', 'I / O')}</span>
            <strong className="sim-kpi-val">
              {inputSpotCount}/{outputSpotCount}
            </strong>
          </div>
        </div>

        <div className="sim-power-bar">
          <div className="sim-power-row">
            <span className="sim-kpi-label">{t('峰值 / 实耗', 'Peak / Active')}</span>
            <strong className="sim-power-val">
              {fmtMW(p.peakDrawMW)} / {fmtMW(p.activeDrawMW)} MW
            </strong>
          </div>
          {powerSubParts.length > 0 && (
            <div className="sim-power-sub">{powerSubParts.join(' · ')} MW</div>
          )}
          <div className="sim-power-row">
            <span className="sim-kpi-label">
              {t('发电量', 'Power Gen')}
              {hasGen ? ` (${p.generatorCount})` : ''}
            </span>
            <strong
              className={`sim-power-val ${
                !hasGen ? '' : p.netBalanceMW >= 0 ? 'ok' : 'warn'
              }`}
            >
              {hasGen
                ? `${fmtMW(p.maxGenMW)} MW (${netSign}${fmtMW(p.netBalanceMW)})`
                : '0.0 MW'}
            </strong>
          </div>
          {genSubParts.length > 0 && (
            <div className="sim-power-sub">
              {genSubParts.join(' + ')} MW ({t('远日保底', 'Min')} {fmtMW(p.minGenMW)} MW)
            </div>
          )}
        </div>

        {report.netInputs.length > 0 && (
          <div className="sim-section">
            <div className="section-label">{t('净输入', 'Net Inputs')}</div>
            <div className="sim-rate-list">
              {report.netInputs.map((item) => (
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

        {report.netOutputs.length > 0 && (
          <div className="sim-section">
            <div className="section-label">{t('净输出', 'Net Outputs')}</div>
            <div className="sim-rate-list">
              {report.netOutputs.map((item) => (
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

        {report.recipeStats.length > 0 && (
          <div className="sim-section">
            <div className="section-label">{t('配方', 'Recipes')}</div>
            <div className="sim-rate-list">
              {report.recipeStats.map((rs) => {
                const rec = getRecipeDef(rs.recipeId);
                const rName = rec ? getRecipeName(rec, lang) : rs.nameZh;
                return (
                  <div key={rs.recipeId} className="sim-rate-row">
                    <span className="sim-rate-name">
                      {rName} ×{rs.machineCount}
                    </span>
                    <span className="sim-rate-num">
                      {Math.round(rs.avgEfficiency * 100)}% ·{' '}
                      {rs.actualOutputRates.map((o) => `${o.ratePerSec.toFixed(2)}/s`).join(' + ')}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {report.balanceHints.length > 0 && (
          <div className="sim-section">
            <div className="section-label">
              {t(`配平提示 (${report.balanceHints.length})`, `Balance Hints (${report.balanceHints.length})`)}
            </div>
            <div className="sim-rate-list">
              {report.balanceHints.slice(0, 12).map((bh) => {
                const msg = isEn
                  ? `${getItemName(bh.itemId, 'en')} supply ${bh.supplyRatePerSec.toFixed(2)}/s > demand ${bh.demandRatePerSec.toFixed(2)}/s (~${Math.round(bh.estDutyRatio * 100)}% duty)`
                  : bh.message;
                return (
                  <button
                    key={bh.id}
                    type="button"
                    className="sim-issue-item warn input-spot"
                    onClick={() =>
                      onFocusIssue({
                        id: bh.id,
                        severity: 'warn',
                        code: 'external-input-needed',
                        message: msg,
                        floor: bh.floor,
                        x: bh.x,
                        y: bh.y,
                      })
                    }
                  >
                    <span className="sim-issue-msg">{msg}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="sim-section">
          <div className="section-label">
            {t(`诊断项 (${report.issues.length})`, `Issues (${report.issues.length})`)}
          </div>
          {report.issues.length === 0 ? (
            <div className="sim-empty">{t('无异常', 'No issues')}</div>
          ) : (
            (() => {
              const activeIdx = activeIssueId ? report.issues.findIndex((i) => i.id === activeIssueId) : -1;
              const limit = activeIdx >= 80 ? activeIdx + 5 : 80;
              return (
                <div className="sim-issue-list">
                  {report.issues.slice(0, limit).map((issue) => (
                    <button
                      key={issue.id}
                      ref={(node) => {
                        if (node) issueRefs.current.set(issue.id, node);
                        else issueRefs.current.delete(issue.id);
                      }}
                      type="button"
                      className={`sim-issue-item ${issue.severity}${
                        issue.code === 'external-input-needed' || issue.code === 'blueprint-output' ? ' input-spot' : ''
                      }${issue.id === activeIssueId ? ' active' : ''}`}
                      onClick={() => onFocusIssue(issue)}
                    >
                      <span className="sim-issue-badge">{codeLabels[issue.code]}</span>
                      <span className="sim-issue-msg">{issue.message}</span>
                      <span className="sim-issue-coord">
                        {formatFloorTag(issue.floor)} ({issue.x},{issue.y})
                      </span>
                    </button>
                  ))}
                  {report.issues.length > limit && (
                    <div className="sim-empty">
                      {isEn
                        ? `${report.issues.length - limit} more folded…`
                        : `其余 ${report.issues.length - limit} 条已折叠…`}
                    </div>
                  )}
                </div>
              );
            })()
          )}
        </div>
      </div>
    </aside>
  );
};
