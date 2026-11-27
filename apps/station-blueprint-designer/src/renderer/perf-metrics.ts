import type * as THREE from 'three';

export type CadPerfStage = 'syncState' | 'preview' | 'boxSelect' | 'render';

export interface CadTimingSnapshot {
  samples: number;
  lastMs: number;
  averageMs: number;
  p95Ms: number;
  maxMs: number;
}

export interface CadPerfSnapshot {
  frames: number;
  frameMs: CadTimingSnapshot;
  frameCpuMs: CadTimingSnapshot;
  stages: Record<CadPerfStage, CadTimingSnapshot>;
  renderer: {
    calls: number;
    triangles: number;
    geometries: number;
    textures: number;
    programs: number;
  };
  rafPending: number;
  rafMaxPending: number;
  rafInvariantViolations: number;
}

class SlidingTiming {
  private readonly values: Float64Array;
  private cursor = 0;
  private count = 0;
  private last = 0;

  constructor(capacity: number) {
    this.values = new Float64Array(capacity);
  }

  record(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.values[this.cursor] = value;
    this.cursor = (this.cursor + 1) % this.values.length;
    if (this.count < this.values.length) this.count++;
    this.last = value;
  }

  snapshot(): CadTimingSnapshot {
    if (this.count === 0) {
      return Object.freeze({ samples: 0, lastMs: 0, averageMs: 0, p95Ms: 0, maxMs: 0 });
    }
    const ordered = new Array<number>(this.count);
    let sum = 0;
    let max = 0;
    for (let i = 0; i < this.count; i++) {
      const value = this.values[i];
      ordered[i] = value;
      sum += value;
      max = Math.max(max, value);
    }
    ordered.sort((a, b) => a - b);
    return Object.freeze({
      samples: this.count,
      lastMs: this.last,
      averageMs: sum / this.count,
      p95Ms: ordered[Math.min(this.count - 1, Math.ceil(this.count * 0.95) - 1)],
      maxMs: max,
    });
  }
}

export class CadPerfMetrics {
  private readonly frameMs = new SlidingTiming(180);
  private readonly frameCpuMs = new SlidingTiming(180);
  private readonly stages: Record<CadPerfStage, SlidingTiming> = {
    syncState: new SlidingTiming(180),
    preview: new SlidingTiming(180),
    boxSelect: new SlidingTiming(180),
    render: new SlidingTiming(180),
  };
  private lastFrameTimestamp = 0;
  private frames = 0;
  private rafPending = 0;
  private rafMaxPending = 0;
  private rafInvariantViolations = 0;

  recordStage(stage: CadPerfStage, startedAt: number): void {
    this.stages[stage].record(performance.now() - startedAt);
  }

  recordFrame(timestamp: number, workStartedAt: number): void {
    if (this.lastFrameTimestamp > 0) this.frameMs.record(timestamp - this.lastFrameTimestamp);
    this.lastFrameTimestamp = timestamp;
    this.frameCpuMs.record(performance.now() - workStartedAt);
    this.frames++;
  }

  noteRafScheduled(): void {
    this.rafPending++;
    this.rafMaxPending = Math.max(this.rafMaxPending, this.rafPending);
    if (this.rafPending > 1) this.rafInvariantViolations++;
  }

  noteRafFired(): void {
    this.rafPending = Math.max(0, this.rafPending - 1);
  }

  noteRafCancelled(): void {
    this.rafPending = 0;
  }

  snapshot(info: THREE.WebGLInfo): CadPerfSnapshot {
    const stageSnapshot = {
      syncState: this.stages.syncState.snapshot(),
      preview: this.stages.preview.snapshot(),
      boxSelect: this.stages.boxSelect.snapshot(),
      render: this.stages.render.snapshot(),
    };
    const renderer = Object.freeze({
      calls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
    });
    Object.freeze(stageSnapshot);
    return Object.freeze({
      frames: this.frames,
      frameMs: this.frameMs.snapshot(),
      frameCpuMs: this.frameCpuMs.snapshot(),
      stages: Object.freeze(stageSnapshot),
      renderer,
      rafPending: this.rafPending,
      rafMaxPending: this.rafMaxPending,
      rafInvariantViolations: this.rafInvariantViolations,
    });
  }
}

declare global {
  interface Window {
    readonly __MS_CAD_PERF__?: CadPerfSnapshot;
  }
}
