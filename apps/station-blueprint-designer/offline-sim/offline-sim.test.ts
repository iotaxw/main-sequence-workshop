import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBlueprintJson, runOfflineFullStationSimulation } from './src/engine';
import { renderOfflineReportHtml } from './src/report-html';

const DEFAULT_BP_PATH = path.resolve(
  __dirname,
  '../src/data/default-blueprints/星穹总线超市/02-星穹金字塔-完整带线总图.json'
);
const REPORT_DIR = path.resolve(__dirname, 'report');

describe('Offline Full-Station Simulation Sub-App (station-blueprint-designer/offline-sim)', () => {
  const targetPath = process.env.SIM_BP_PATH ? path.resolve(process.env.SIM_BP_PATH) : DEFAULT_BP_PATH;
  const doc = parseBlueprintJson(fs.readFileSync(targetPath, 'utf8'));
  const report = runOfflineFullStationSimulation(doc);

  it('passes all 5 verification passes (50/50 production rooms, all hubs, cross-room seams, flow/energy, and global integrity)', () => {
    console.log(`\n========== OFFLINE FULL-STATION SIMULATION REPORT: ${report.blueprintName} ==========`);
    console.log(
      `Pass 1 (Rooms): ${report.productionRooms.filter((r) => r.errors.length === 0 && r.anomalyWarns.length === 0).length}/${report.productionRooms.length} production CLEAN | ${report.hubRooms.filter((h) => h.errors.length === 0 && h.anomalyWarns.length === 0).length}/${report.hubRooms.length} hubs CLEAN`
    );
    for (const r of report.productionRooms) {
      const outStr = r.outputs.map((o) => `${o.nameZh} ${o.ratePerSec.toFixed(2)}/s`).join(', ');
      console.log(
        `  [${r.floorLabel}] ${r.label.padEnd(36)} | ${String(r.machineCount).padStart(2)}台 | eff=${(r.avgEfficiency * 100).toFixed(1).padStart(5)}% | ${r.powerPeakMW.toFixed(0).padStart(3)} MW | 产: ${outStr}`
      );
    }

    console.log('\nPass 2 (Cross-Room Seams):');
    for (const s of report.seams) {
      console.log(`  - ${s.name}: ${s.buildingCount} blds, seamFaults=${s.seamFaults.length}, totalErr=${s.totalErrors}`);
    }

    console.log('\nPass 3 (External Inputs & Key B1 Self-Supply):');
    console.log(
      '  External-only raw inputs (' +
        report.externalInputs.length +
        '): ' +
        report.externalInputs.map((e) => `${e.nameZh} ${e.consumedAllOnPerSec.toFixed(2)}/s`).join(', ')
    );
    const findItem = (id: string) => report.itemBalances.find((x) => x.itemId === id);
    const proto = findItem('ITEM_Protomatter')!;
    const graph = findItem('ITEM_Graphite')!;
    const silica = findItem('ITEM_Silica')!;
    const ice = findItem('ITEM_WaterIce')!;
    console.log(
      `  B1 Core: 原物质 ${proto.producedPerSec.toFixed(2)}/s vs 耗 ${proto.consumedAllOnPerSec.toFixed(2)}/s (净+${proto.netAllOnPerSec.toFixed(2)}/s) | 石墨 ${graph.producedPerSec.toFixed(2)}/s | 二氧化硅 ${silica.producedPerSec.toFixed(2)}/s | 水冰 ${ice.producedPerSec.toFixed(2)}/s`
    );

    console.log('\nPass 4 (Power & Orbit Margins):');
    console.log(
      `  Solar: ${report.power.solarMk2Count}x Mk.2 + ${report.power.solarMk3Count}x Mk.3 = ${report.power.maxSolarMW.toFixed(0)} MW (100%) / ${report.power.minSolarMW.toFixed(1)} MW (20%)`
    );
    console.log(
      `  Peak Draw: B1 ${report.power.b1CrafterPeakMW.toFixed(0)} MW + F1 ${report.power.f1CrafterPeakMW.toFixed(0)} MW + Facilities ${report.power.facilityPeakMW.toFixed(0)} MW + Turrets ${report.power.turretPeakMW.toFixed(0)} MW = ${report.power.combatPeakMW.toFixed(0)} MW`
    );
    for (const o of report.power.orbits) {
      console.log(
        `  - ${o.orbitLabel}: 发电 ${o.solarGenMW.toFixed(1)} MW | 全开峰值余 ${o.netVsCombatPeakMW >= 0 ? '+' : ''}${o.netVsCombatPeakMW.toFixed(1)} MW | 超市25%日常余 ${o.netVsMall25PctMW >= 0 ? '+' : ''}${o.netVsMall25PctMW.toFixed(1)} MW`
      );
    }

    console.log(
      `\nPass 5 (Global Integrity): ${report.integrity.moduleCount} modules, ${report.integrity.buildingCount} buildings, ${report.integrity.occupiedCells} cells, overlaps=${report.integrity.overlaps}, outOfFloor=${report.integrity.outOfFloor}, turrets=${report.integrity.outwardTurretCount}/8 outward`
    );

    // Optional report artifact generation (triggered via npm run sim:report or SIM_WRITE_REPORT=1)
    if (process.env.SIM_WRITE_REPORT === '1') {
      fs.mkdirSync(REPORT_DIR, { recursive: true });
      const htmlPath = path.join(REPORT_DIR, 'latest-report.html');
      const jsonPath = path.join(REPORT_DIR, 'latest-report.json');
      fs.writeFileSync(htmlPath, renderOfflineReportHtml(report), 'utf8');
      fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
      console.log(`\nOffline HTML dashboard written to: ${htmlPath}`);
    }

    // Strict assertions across all 5 passes
    expect(report.productionRooms.length).toBe(50);
    for (const r of report.productionRooms) {
      expect(r.errors, `Production room ${r.label} errors`).toEqual([]);
      expect(r.anomalyWarns, `Production room ${r.label} anomaly warnings`).toEqual([]);
      expect(r.avgEfficiency, `Production room ${r.label} steady efficiency`).toBeGreaterThanOrEqual(0.7);
    }
    for (const h of report.hubRooms) {
      expect(h.errors, `Hub ${h.label} errors`).toEqual([]);
      expect(h.anomalyWarns, `Hub ${h.label} anomaly warnings`).toEqual([]);
    }
    expect(report.seams.length).toBe(6);
    for (const s of report.seams) {
      expect(s.seamFaults, `Cross-room seam "${s.name}" faults`).toEqual([]);
    }
    expect(report.externalInputs.length).toBe(4);
    expect(proto.producedPerSec).toBeGreaterThanOrEqual(proto.consumedAllOnPerSec - 0.01);
    expect(graph.producedPerSec).toBeCloseTo(4.5, 1);
    expect(silica.producedPerSec).toBeCloseTo(4.5, 1);
    expect(ice.producedPerSec).toBeCloseTo(3.0, 1);
    expect(report.power.maxSolarMW).toBe(9984);
    expect(report.power.maxSolarMW - report.power.combatPeakMW).toBeGreaterThan(4000);
    expect(report.power.minSolarMW).toBeGreaterThan(report.power.mallTypical25PctMW);
    expect(report.integrity.overlaps).toBe(0);
    expect(report.integrity.outOfFloor).toBe(0);
    expect(report.integrity.invalidRecipes).toBe(0);
    expect(report.integrity.turretsValid).toBe(true);
    expect(report.passed).toBe(true);
  });
});
