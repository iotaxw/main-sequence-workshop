import React from 'react';
import type { SimulationIssue, SimulationReport } from '../core/simulation';

interface SimulationPanelProps {
  open: boolean;
  report: SimulationReport | null;
  onClose: () => void;
  onFocusIssue: (issue: SimulationIssue) => void;
}

const CODE_LABEL: Record<SimulationIssue['code'], string> = {
  'orphan-belt': '悬空无源',
  'dead-end-belt': '末端断带',
  'head-on-belt': '正面相撞',
  'unpaired-underground': '下层未配对',
  'splitter-leak': '分流侧漏',
  'port-mismatch': '端口冲突',
  'mixed-item-belt': '混料污染',
  'belt-overload': '传送超载',
  'machine-missing-input': '机器缺料',
  'machine-wrong-item': '机器错料',
  'machine-blocked-output': '出料未接',
};

export const SimulationPanel: React.FC<SimulationPanelProps> = ({ open, report, onClose, onFocusIssue }) => {
  if (!open || !report) return null;

  const effPct = Math.round(report.avgEfficiency * 1000) / 10;

  return (
    <aside className="cad-sim-panel" aria-label="产线模拟与体检">
      <div className="panel-header">
        <div className="panel-title-wrap">
          <span className="panel-tag">SIM</span>
          <span className="panel-title">产线模拟与流量体检</span>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} title="关闭产线模拟">
          ×
        </button>
      </div>

      <div className="sim-body">
        <div className={`sim-verdict ${report.passed ? 'ok' : 'err'}`}>
          <span className="sim-verdict-dot" />
          <span>
            {report.passed
              ? report.warnCount === 0
                ? '异常归零 · 产线全部跑通'
                : `0 错误 · 产线跑通（${report.warnCount} 条提示）`
              : `发现 ${report.errorCount} 处阻断异常${report.warnCount ? ` · ${report.warnCount} 提示` : ''}`}
          </span>
        </div>

        <div className="sim-kpi-grid">
          <div className="sim-kpi">
            <span className="sim-kpi-label">综合效率</span>
            <strong className="sim-kpi-val">{effPct}%</strong>
          </div>
          <div className="sim-kpi">
            <span className="sim-kpi-label">配配方机器</span>
            <strong className="sim-kpi-val">
              {report.configuredMachineCount}/{report.machineCount}
            </strong>
          </div>
          <div className="sim-kpi">
            <span className="sim-kpi-label">产线功耗</span>
            <strong className="sim-kpi-val">{report.totalPowerMW.toFixed(1)} MW</strong>
          </div>
        </div>

        {report.netInputs.length > 0 && (
          <div className="sim-section">
            <div className="section-label">净外部输入（消耗速率）</div>
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
            异常清单（{report.issues.length}）{report.issues.length > 0 ? ' · 点击定位' : ''}
          </div>
          {report.issues.length === 0 ? (
            <div className="sim-empty">无断带、无悬空、无侧漏、无混料，全图拓扑与流率正常。</div>
          ) : (
            <div className="sim-issue-list">
              {report.issues.slice(0, 60).map((issue) => (
                <button
                  key={issue.id}
                  type="button"
                  className={`sim-issue-item ${issue.severity}`}
                  onClick={() => onFocusIssue(issue)}
                >
                  <span className="sim-issue-badge">{CODE_LABEL[issue.code]}</span>
                  <span className="sim-issue-msg">{issue.message}</span>
                  <span className="sim-issue-coord">
                    L{issue.floor} ({issue.x},{issue.y})
                  </span>
                </button>
              ))}
              {report.issues.length > 60 && (
                <div className="sim-empty">其余 {report.issues.length - 60} 条异常已折叠…</div>
              )}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
};
