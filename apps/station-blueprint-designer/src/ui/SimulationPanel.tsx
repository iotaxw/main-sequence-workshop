import React from 'react';
import type { SimulationIssue, SimulationReport } from '../core/simulation';

interface SimulationPanelProps {
  open: boolean;
  report: SimulationReport | null;
  onClose: () => void;
  onFocusIssue: (issue: SimulationIssue) => void;
}

const CODE_LABEL: Record<SimulationIssue['code'], string> = {
  'external-input-needed': '首·需入原料',
  'blueprint-output': '尾·产线出口',
  'power-deficit': '供电不足',
  'orphan-belt': '孤立废带',
  'dead-end-belt': '撞墙死路',
  'head-on-belt': '正面相撞',
  'unpaired-underground': '地下带断连',
  'splitter-leak': '分流侧漏',
  'port-mismatch': '端口错接',
  'mixed-item-belt': '混料污染',
  'belt-overload': '传送超载',
  'machine-missing-input': '机器缺料',
  'machine-wrong-item': '机器错料',
  'machine-blocked-output': '出料未接',
};

function fmtMW(mw: number): string {
  return Math.abs(mw) >= 100 ? mw.toFixed(0) : mw.toFixed(1);
}

export const SimulationPanel: React.FC<SimulationPanelProps> = ({ open, report, onClose, onFocusIssue }) => {
  if (!open || !report) return null;

  const effText =
    report.configuredMachineCount > 0 ? `${Math.round(report.avgEfficiency * 1000) / 10}%` : '—';
  const inputSpotCount = report.externalInputs.length;
  const outputSpotCount = report.externalOutputs.length;
  const p = report.power;
  const hasGen = p.maxGenMW > 0;
  const netSign = p.netBalanceMW >= 0 ? '+' : '';

  const ioText =
    inputSpotCount > 0 || outputSpotCount > 0 ? `${inputSpotCount} 进 / ${outputSpotCount} 出` : '';
  const verdictText = !report.passed
    ? `发现 ${report.errorCount} 处中段故障${ioText ? ` · ${ioText}` : ''}`
    : report.anomalyWarnCount === 0
      ? ioText
        ? `0 故障 · 首尾接口正常（${ioText}）`
        : '异常归零 · 产线全部跑通'
      : `0 故障 · ${report.anomalyWarnCount} 项预警${ioText ? ` · ${ioText}` : ''}`;

  const powerSubParts: string[] = [];
  if (p.crafterPeakMW > 0) powerSubParts.push(`产线 ${fmtMW(p.crafterPeakMW)}`);
  if (p.labPeakMW > 0) powerSubParts.push(`科研 ${fmtMW(p.labPeakMW)}`);
  if (p.facilityPeakMW > 0) powerSubParts.push(`设施 ${fmtMW(p.facilityPeakMW)}`);

  const genSubParts: string[] = [];
  if (p.solarGenMW > 0) genSubParts.push(`光伏 ${fmtMW(p.solarGenMW)}`);
  if (p.reactorGenMW > 0) genSubParts.push(`反应堆 ${fmtMW(p.reactorGenMW)}`);

  return (
    <aside className="cad-sim-panel" aria-label="产线模拟与体检">
      <div className="panel-header">
        <div className="panel-title-wrap">
          <span className="panel-tag">SIM</span>
          <span className="panel-title">产线模拟与体检</span>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} title="关闭产线模拟">
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
            <span className="sim-kpi-label">综合效率</span>
            <strong className="sim-kpi-val">{effText}</strong>
          </div>
          <div className="sim-kpi">
            <span className="sim-kpi-label">配配方机器</span>
            <strong className="sim-kpi-val">
              {report.configuredMachineCount}/{report.machineCount}
            </strong>
          </div>
          <div className="sim-kpi">
            <span className="sim-kpi-label">首 / 尾接口</span>
            <strong className="sim-kpi-val">
              {inputSpotCount}进 / {outputSpotCount}出
            </strong>
          </div>
        </div>

        <div className="sim-power-bar">
          <div className="sim-power-row">
            <span className="sim-kpi-label">额定峰值 / 稳态实耗</span>
            <strong className="sim-power-val">
              {fmtMW(p.peakDrawMW)} / {fmtMW(p.activeDrawMW)} MW
            </strong>
          </div>
          {powerSubParts.length > 0 && (
            <div className="sim-power-sub">负载构成：{powerSubParts.join(' · ')} MW</div>
          )}
          <div className="sim-power-row">
            <span className="sim-kpi-label">最大发电量{hasGen ? `（${p.generatorCount} 台）` : ''}</span>
            <strong
              className={`sim-power-val ${
                !hasGen ? '' : p.netBalanceMW >= 0 ? 'ok' : 'warn'
              }`}
            >
              {hasGen
                ? `${fmtMW(p.maxGenMW)} MW（${netSign}${fmtMW(p.netBalanceMW)}）`
                : '0.0 MW（未建电源）'}
            </strong>
          </div>
          {genSubParts.length > 0 && (
            <div className="sim-power-sub">电源构成：{genSubParts.join(' + ')} MW（满载上限）</div>
          )}
        </div>

        {report.netInputs.length > 0 && (
          <div className="sim-section">
            <div className="section-label">净外部输入（总需求速率）</div>
            <div className="sim-rate-list">
              {report.netInputs.map((item) => (
                <div key={item.itemId} className="sim-rate-row">
                  <span className="sim-rate-name">{item.nameZh}</span>
                  <span className="sim-rate-num">
                    {item.ratePerSec.toFixed(2)}/s · {item.beltsMk3.toFixed(2)}带
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {report.netOutputs.length > 0 && (
          <div className="sim-section">
            <div className="section-label">净外部输出（稳态产出）</div>
            <div className="sim-rate-list">
              {report.netOutputs.map((item) => (
                <div key={item.itemId} className="sim-rate-row">
                  <span className="sim-rate-name">{item.nameZh}</span>
                  <span className="sim-rate-num out">
                    {item.ratePerSec.toFixed(2)}/s · {item.beltsMk3.toFixed(2)}带
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {report.recipeStats.length > 0 && (
          <div className="sim-section">
            <div className="section-label">配方运行一览</div>
            <div className="sim-rate-list">
              {report.recipeStats.map((rs) => (
                <div key={rs.recipeId} className="sim-rate-row">
                  <span className="sim-rate-name">
                    {rs.nameZh} ×{rs.machineCount}
                  </span>
                  <span className="sim-rate-num">
                    {Math.round(rs.avgEfficiency * 100)}% ·{' '}
                    {rs.actualOutputRates.map((o) => `${o.ratePerSec.toFixed(2)}/s`).join(' + ')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="sim-section">
          <div className="section-label">
            提示与异常清单（{report.issues.length}）{report.issues.length > 0 ? ' · 点击定位' : ''}
          </div>
          {report.issues.length === 0 ? (
            <div className="sim-empty">无断带、无悬空、无侧漏、无混料，且无需额外入料。</div>
          ) : (
            <div className="sim-issue-list">
              {report.issues.slice(0, 80).map((issue) => (
                <button
                  key={issue.id}
                  type="button"
                  className={`sim-issue-item ${issue.severity}${
                    issue.code === 'external-input-needed' || issue.code === 'blueprint-output' ? ' input-spot' : ''
                  }`}
                  onClick={() => onFocusIssue(issue)}
                >
                  <span className="sim-issue-badge">{CODE_LABEL[issue.code]}</span>
                  <span className="sim-issue-msg">{issue.message}</span>
                  <span className="sim-issue-coord">
                    L{issue.floor} ({issue.x},{issue.y})
                  </span>
                </button>
              ))}
              {report.issues.length > 80 && (
                <div className="sim-empty">其余 {report.issues.length - 80} 条提示/异常已折叠…</div>
              )}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
};
