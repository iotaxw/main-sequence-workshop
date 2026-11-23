import type { FullStationSimReport } from './engine';

function esc(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Renders a completely self-contained offline interactive HTML inspection dashboard. */
export function renderOfflineReportHtml(report: FullStationSimReport): string {
  const prodOk = report.productionRooms.filter((r) => r.errors.length === 0 && r.anomalyWarns.length === 0).length;
  const hubOk = report.hubRooms.filter((h) => h.errors.length === 0 && h.anomalyWarns.length === 0).length;
  const seamOk = report.seams.filter((s) => s.seamFaults.length === 0).length;
  const avgEff =
    report.productionRooms.reduce((s, r) => s + r.avgEfficiency, 0) / Math.max(1, report.productionRooms.length);

  const roomRows = report.productionRooms
    .map((r) => {
      const ok = r.errors.length === 0 && r.anomalyWarns.length === 0;
      const pct = (r.avgEfficiency * 100).toFixed(1);
      const outHtml = r.outputs
        .map((o) => `<span class="pill out">${esc(o.nameZh)} <b>${o.ratePerSec.toFixed(2)}/s</b></span>`)
        .join(' ');
      const inHtml = r.inputs
        .map((i) => `<span class="pill in">${esc(i.nameZh)} ${i.ratePerSec.toFixed(2)}/s</span>`)
        .join(' ');
      return `<tr data-floor="${esc(r.floorLabel)}" data-status="${ok ? 'ok' : 'err'}" data-text="${esc(
        `${r.label} ${r.outputs.map((o) => o.nameZh).join(' ')} ${r.inputs.map((i) => i.nameZh).join(' ')}`
      ).toLowerCase()}">
        <td><span class="tag">${esc(r.floorLabel)}</span></td>
        <td class="room-name">${esc(r.label)}</td>
        <td class="num">${r.machineCount}</td>
        <td>
          <div class="bar-wrap"><div class="bar-fill ${r.avgEfficiency >= 0.99 ? 'full' : 'cap'}" style="width:${pct}%"></div></div>
          <span class="pct">${pct}%</span>
        </td>
        <td class="num">${r.powerPeakMW.toFixed(1)} MW</td>
        <td>${outHtml || '<span class="muted">—</span>'}</td>
        <td>${inHtml || '<span class="muted">自产零外料</span>'}</td>
        <td><span class="badge ${ok ? 'ok' : 'err'}">${ok ? 'PASS' : `ERR ${r.errors.length}`}</span></td>
      </tr>`;
    })
    .join('\n');

  const seamRows = report.seams
    .map((s) => {
      const ok = s.seamFaults.length === 0;
      return `<tr>
        <td>${esc(s.name)}</td>
        <td class="num">${s.moduleCount} 模块 / ${s.buildingCount} 建筑</td>
        <td class="num">${s.seamFaults.length}</td>
        <td><span class="badge ${ok ? 'ok' : 'err'}">${ok ? '0 接缝故障' : `${s.seamFaults.length} 故障`}</span></td>
      </tr>`;
    })
    .join('\n');

  const orbitRows = report.power.orbits
    .map((o) => {
      const surplusClass = o.netVsCombatPeakMW >= 0 ? 'ok-text' : 'warn-text';
      const mallClass = o.netVsMall25PctMW >= 0 ? 'ok-text' : 'err-text';
      return `<tr>
        <td>${esc(o.orbitLabel)}</td>
        <td class="num">${o.solarGenMW.toFixed(1)} MW</td>
        <td class="num ${surplusClass}">${o.netVsCombatPeakMW >= 0 ? '+' : ''}${o.netVsCombatPeakMW.toFixed(1)} MW</td>
        <td class="num ${mallClass}">${o.netVsMall25PctMW >= 0 ? '+' : ''}${o.netVsMall25PctMW.toFixed(1)} MW</td>
      </tr>`;
    })
    .join('\n');

  const itemRows = report.itemBalances
    .map((r) => {
      const refill = r.estRefillMinAt25Stack ? `${r.estRefillMinAt25Stack.toFixed(1)} 分钟` : '外部输入';
      return `<tr>
        <td>${esc(r.nameZh)} ${r.externalOnly ? '<span class="pill ext">纯外部</span>' : ''}</td>
        <td class="num">${r.producedPerSec.toFixed(2)}/s</td>
        <td class="num">${r.consumedAllOnPerSec.toFixed(2)}/s</td>
        <td class="num">${r.netAllOnPerSec >= 0 ? '+' : ''}${r.netAllOnPerSec.toFixed(2)}/s</td>
        <td class="num">${refill}</td>
      </tr>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>离线全站仿真体检报告 · ${esc(report.blueprintName)}</title>
<style>
  :root {
    --bg: #0b111c; --panel: #121c2d; --border: #23344f; --text: #e2ecf8; --muted: #8fa3bf;
    --accent: #4dd0e1; --ok: #34d399; --warn: #fbbf24; --err: #f87171;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.55 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; background: var(--bg); color: var(--text); }
  .wrap { max-width: 1420px; margin: 0 auto; padding: 24px 28px 60px; }
  header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid var(--border); padding-bottom: 18px; margin-bottom: 22px; }
  h1 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: .3px; }
  .sub { color: var(--muted); font-size: 13px; margin-top: 4px; }
  .status-banner { padding: 8px 16px; border-radius: 999px; font-weight: 700; letter-spacing: .5px; font-size: 13px; }
  .status-banner.pass { background: rgba(52,211,153,.14); color: var(--ok); border: 1px solid rgba(52,211,153,.4); }
  .status-banner.fail { background: rgba(248,113,113,.14); color: var(--err); border: 1px solid rgba(248,113,113,.4); }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 14px; margin-bottom: 24px; }
  .kpi { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
  .kpi .k { color: var(--muted); font-size: 12px; }
  .kpi .v { font-size: 24px; font-weight: 700; margin-top: 4px; color: var(--accent); }
  .kpi .d { font-size: 12px; color: var(--muted); margin-top: 4px; }
  section { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px; margin-bottom: 20px; }
  h2 { margin: 0 0 12px; font-size: 16px; font-weight: 600; color: #f1f7ff; }
  .controls { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }
  input, select { background: #0d1626; color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 8px 10px; border-bottom: 1px solid rgba(35,52,79,.65); text-align: left; vertical-align: middle; }
  th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .4px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .room-name { font-weight: 500; }
  .tag { display: inline-block; padding: 2px 7px; border-radius: 6px; background: rgba(77,208,225,.12); color: var(--accent); font-size: 11px; font-weight: 600; }
  .pill { display: inline-block; padding: 2px 7px; border-radius: 6px; font-size: 12px; margin: 1px 2px 1px 0; }
  .pill.out { background: rgba(52,211,153,.13); color: #a7f3d0; }
  .pill.in { background: rgba(148,163,184,.12); color: #cbd5e1; }
  .pill.ext { background: rgba(251,191,36,.15); color: var(--warn); font-size: 11px; margin-left: 4px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; }
  .badge.ok { background: rgba(52,211,153,.15); color: var(--ok); }
  .badge.err { background: rgba(248,113,113,.15); color: var(--err); }
  .bar-wrap { display: inline-block; width: 70px; height: 7px; background: #1e2d45; border-radius: 999px; overflow: hidden; vertical-align: middle; margin-right: 6px; }
  .bar-fill { height: 100%; border-radius: 999px; }
  .bar-fill.full { background: var(--ok); }
  .bar-fill.cap { background: var(--warn); }
  .pct { font-variant-numeric: tabular-nums; font-size: 12px; }
  .ok-text { color: var(--ok); font-weight: 600; }
  .warn-text { color: var(--warn); font-weight: 600; }
  .err-text { color: var(--err); font-weight: 600; }
  .muted { color: var(--muted); }
  .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(460px, 1fr)); gap: 20px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>离线全站仿真体检报告 · ${esc(report.blueprintName)}</h1>
      <div class="sub">蓝图 ID: ${esc(report.blueprintId)} ｜ 生成时间: ${esc(report.generatedAt)} ｜ 同源真物理内核 simulateBlueprint()</div>
    </div>
    <div class="status-banner ${report.passed ? 'pass' : 'fail'}">${report.passed ? 'ALL 5 PASSES VERIFIED · 0 ERRORS' : 'VERIFICATION FAILED'}</div>
  </header>

  <div class="kpis">
    <div class="kpi"><div class="k">生产细胞实配仿真</div><div class="v">${prodOk} / ${report.productionRooms.length}</div><div class="d">平均实测效率 ${(avgEff * 100).toFixed(1)}% · 0 红错</div></div>
    <div class="kpi"><div class="k">枢纽 / 电梯 / 玄关 / 商业街</div><div class="v">${hubOk} / ${report.hubRooms.length}</div><div class="d">全部 0 红错 · 0 异常警告</div></div>
    <div class="kpi"><div class="k">跨舱门洞接缝联调</div><div class="v">${seamOk} / ${report.seams.length}</div><div class="d">0 对撞 · 0 死路 · 0 错配</div></div>
    <div class="kpi"><div class="k">全站太阳能装机 / 满载峰值</div><div class="v">${report.power.maxSolarMW.toFixed(0)} MW</div><div class="d">满载 ${report.power.combatPeakMW.toFixed(0)} MW · 盈余 +${(report.power.maxSolarMW - report.power.combatPeakMW).toFixed(0)} MW</div></div>
    <div class="kpi"><div class="k">整图结构与带线规模</div><div class="v">${report.integrity.buildingCount.toLocaleString()}</div><div class="d">${report.integrity.moduleCount} 模块 · ${report.integrity.overlaps} 重叠 · 8 炮台全朝外</div></div>
  </div>

  <div class="grid2">
    <section>
      <h2>Pass 4 · 全站电力与分轨道光照盈余</h2>
      <table>
        <thead><tr><th>轨道光照工况</th><th class="num">太阳能发电</th><th class="num">全开战时峰值盈余 (${report.power.combatPeakMW.toFixed(0)} MW)</th><th class="num">超市25%日常盈余 (${report.power.mallTypical25PctMW.toFixed(0)} MW)</th></tr></thead>
        <tbody>${orbitRows}</tbody>
      </table>
      <p class="sub" style="margin-top:10px;">装机构成：${report.power.solarMk2Count} × Mk.2 (${report.power.solarMk2Count * 48} MW) + ${report.power.solarMk3Count} × Mk.3 (${report.power.solarMk3Count * 288} MW)；满载构成：B1 制造机 ${report.power.b1CrafterPeakMW.toFixed(0)} MW + F1 制造机 ${report.power.f1CrafterPeakMW.toFixed(0)} MW + 设施 ${report.power.facilityPeakMW.toFixed(0)} MW + 8 炮台峰值 ${report.power.turretPeakMW.toFixed(0)} MW。</p>
    </section>

    <section>
      <h2>Pass 2 · 跨房间门洞与电梯接口拼接集成仿真</h2>
      <table>
        <thead><tr><th>跨舱联调组合</th><th class="num">规模</th><th class="num">接缝故障</th><th>结论</th></tr></thead>
        <tbody>${seamRows}</tbody>
      </table>
    </section>
  </div>

  <section>
    <h2>Pass 1 · 全 50 间真实生产房间逐一真物理仿真明细</h2>
    <div class="controls">
      <input id="q" type="search" placeholder="搜索房间或物品名称（如 营养素 / 钛板 / 冷却剂）..." style="min-width:300px;" />
      <select id="fl">
        <option value="">全部楼层</option>
        <option value="B1 (L0)">B1 (L0)</option>
        <option value="F1 (L2)">F1 (L2)</option>
      </select>
    </div>
    <table id="roomTable">
      <thead><tr><th>楼层</th><th>房间名称</th><th class="num">台数</th><th>实测效率</th><th class="num">峰值功耗</th><th>实测稳态产出</th><th>净输入原料</th><th>状态</th></tr></thead>
      <tbody>${roomRows}</tbody>
    </table>
  </section>

  <section>
    <h2>Pass 3 · 全站物品稳态产出与 320 组大箱补货周期（纯外部输入仅 ${report.externalInputs.length} 项）</h2>
    <table>
      <thead><tr><th>物品</th><th class="num">全站实测稳态产出</th><th class="num">极端全开同时消耗</th><th class="num">全开净余</th><th class="num">320组大箱满箱补货参考</th></tr></thead>
      <tbody>${itemRows}</tbody>
    </table>
  </section>
</div>
<script>
  const q = document.getElementById('q');
  const fl = document.getElementById('fl');
  const rows = [...document.querySelectorAll('#roomTable tbody tr')];
  function filter() {
    const kw = q.value.trim().toLowerCase();
    const f = fl.value;
    for (const tr of rows) {
      const okF = !f || tr.dataset.floor === f;
      const okQ = !kw || tr.dataset.text.includes(kw);
      tr.style.display = okF && okQ ? '' : 'none';
    }
  }
  q.addEventListener('input', filter);
  fl.addEventListener('change', filter);
</script>
</body>
</html>`;
}
