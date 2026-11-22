import * as THREE from 'three';
import { FLOOR_VISUAL_SPACING } from '../core/geometry';
import type { ViewMode } from '../core/types';

export const YAW_SNAP_ANGLES = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]; // 0°, 90°, 180°, 270°
export const PITCH_SNAP_PRESETS = [
  { id: 'top', label: '正俯 89°', rad: (89 * Math.PI) / 180 },
  { id: 'work', label: '工作 64°', rad: (64 * Math.PI) / 180 },
  { id: 'iso', label: '轴测 42°', rad: (42 * Math.PI) / 180 },
  { id: 'low', label: '低角 22°', rad: (22 * Math.PI) / 180 },
] as const;

export const MIN_DISTANCE = 9;
export const MAX_DISTANCE = 1200;
export const ZOOM_ENTER_BUILDING = 44; // Crossing below enters Building View
export const ZOOM_EXIT_TO_STATION = 62; // Crossing above returns to Station Overview (hysteresis!)

export interface CameraSnapshot {
  targetX: number;
  targetZ: number;
  focusFloor: number;
  yaw: number;
  pitch: number;
  distance: number;
  snapEnabled: boolean;
}

function normalizeAngle(rad: number): number {
  const twoPi = Math.PI * 2;
  return ((rad % twoPi) + twoPi) % twoPi;
}

function shortestAngleDelta(from: number, to: number): number {
  const twoPi = Math.PI * 2;
  let d = ((to - from) % twoPi + twoPi) % twoPi;
  if (d > Math.PI) d -= twoPi;
  return d;
}

export class CadCameraRig {
  readonly camera: THREE.PerspectiveCamera;

  // Desired (target) state
  targetX = 24;
  targetZ = 16;
  targetFloorY = 0;
  targetYaw = 0;
  targetPitch = PITCH_SNAP_PRESETS[1].rad; // Default slight tilted top-down (~64°)
  targetDistance = 76;
  snapEnabled = true;

  // Smoothed (rendered) state
  private curX = 24;
  private curZ = 16;
  private curY = 0;
  private curYaw = 0;
  private curPitch = PITCH_SNAP_PRESETS[1].rad;
  private curDistance = 76;

  private focusFloor = 0;
  private viewMode: ViewMode = 'station';
  private onAutoViewModeChange?: (mode: ViewMode) => void;
  private onTelemetryChange?: (info: { yawDeg: number; pitchDeg: number; distance: number }) => void;
  private lastTelemetryTime = 0;

  constructor(
    aspect: number,
    callbacks: {
      onAutoViewModeChange?: (mode: ViewMode) => void;
      onTelemetryChange?: (info: { yawDeg: number; pitchDeg: number; distance: number }) => void;
    } = {}
  ) {
    this.camera = new THREE.PerspectiveCamera(42, aspect, 0.8, 6000);
    this.onAutoViewModeChange = callbacks.onAutoViewModeChange;
    this.onTelemetryChange = callbacks.onTelemetryChange;
    this.applyImmediate();
  }

  get currentPitchRad(): number {
    return this.curPitch;
  }

  get currentDistance(): number {
    return this.curDistance;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = Math.max(0.1, aspect);
    this.camera.updateProjectionMatrix();
  }

  setFocusFloor(floor: number): void {
    this.focusFloor = floor;
    this.targetFloorY = floor * FLOOR_VISUAL_SPACING;
  }

  setViewMode(mode: ViewMode, animateDistance = false): void {
    this.viewMode = mode;
    if (animateDistance) {
      this.targetDistance = mode === 'building' ? 28 : 88;
      if (mode === 'building' && this.targetPitch < (48 * Math.PI) / 180) {
        // When entering building view, tilt nicely toward the floor
        this.targetPitch = PITCH_SNAP_PRESETS[1].rad;
      }
    }
  }

  setSnapEnabled(enabled: boolean): void {
    this.snapEnabled = enabled;
    if (enabled) this.snapAngles();
  }

  setPitchPreset(rad: number): void {
    this.targetPitch = THREE.MathUtils.clamp(rad, (14 * Math.PI) / 180, (89.2 * Math.PI) / 180);
  }

  stepYawCardinal(dir: 1 | -1): void {
    const snapped = this.findNearestYaw(this.targetYaw);
    this.targetYaw = normalizeAngle(snapped + dir * (Math.PI / 2));
  }

  private findNearestYaw(rad: number): number {
    let best = YAW_SNAP_ANGLES[0];
    let bestDist = Infinity;
    for (const a of YAW_SNAP_ANGLES) {
      const d = Math.abs(shortestAngleDelta(rad, a));
      if (d < bestDist) {
        bestDist = d;
        best = a;
      }
    }
    return best;
  }

  private findNearestPitch(rad: number): number {
    let best: number = PITCH_SNAP_PRESETS[1].rad;
    let bestDist = Infinity;
    for (const p of PITCH_SNAP_PRESETS) {
      const d = Math.abs(rad - p.rad);
      if (d < bestDist) {
        bestDist = d;
        best = p.rad;
      }
    }
    return best;
  }

  orbitByPixels(dx: number, dy: number): void {
    const yawSpeed = 0.0065;
    const pitchSpeed = 0.0055;
    this.targetYaw = normalizeAngle(this.targetYaw - dx * yawSpeed);
    this.targetPitch = THREE.MathUtils.clamp(
      this.targetPitch + dy * pitchSpeed,
      (14 * Math.PI) / 180,
      (89.2 * Math.PI) / 180
    );
  }

  snapAngles(): void {
    if (!this.snapEnabled) return;
    this.targetYaw = this.findNearestYaw(this.targetYaw);
    this.targetPitch = this.findNearestPitch(this.targetPitch);
  }

  panByScreenDelta(dxPx: number, dyPx: number, viewportHeight: number): void {
    const fovRad = (this.camera.fov * Math.PI) / 180;
    const worldPerPx = (2 * this.curDistance * Math.tan(fovRad / 2)) / Math.max(1, viewportHeight);
    const cosY = Math.cos(this.curYaw);
    const sinY = Math.sin(this.curYaw);
    // Screen right = (+cosY, -sinY), Screen up = (-sinY, -cosY)
    // Grab-panning: dragging right (+dxPx) moves camera left; dragging down (+dyPx) moves camera up.
    const moveRight = -dxPx * worldPerPx;
    const moveUp = (dyPx * worldPerPx) / Math.max(0.35, Math.sin(this.curPitch));
    this.targetX += moveRight * cosY - moveUp * sinY;
    this.targetZ += -moveRight * sinY - moveUp * cosY;
  }

  panByAxes(rightAxis: number, forwardAxis: number, dt: number): void {
    const speed = Math.max(16, this.curDistance * 0.95) * dt;
    const cosY = Math.cos(this.curYaw);
    const sinY = Math.sin(this.curYaw);
    // W (forwardAxis = +1) moves toward screen-top (-sinY, -cosY)
    this.targetX += (rightAxis * cosY - forwardAxis * sinY) * speed;
    this.targetZ += (-rightAxis * sinY - forwardAxis * cosY) * speed;
  }

  /**
   * Cursor-anchored zoom with smooth hysteresis switching between Station Overview & Building View.
   */
  zoomByWheel(deltaY: number, anchorWorld: THREE.Vector3 | null): void {
    const factor = Math.exp(Math.sign(deltaY) * Math.min(Math.abs(deltaY), 160) * 0.0018);
    const prevDist = this.targetDistance;
    const nextDist = THREE.MathUtils.clamp(prevDist * factor, MIN_DISTANCE, MAX_DISTANCE);
    this.targetDistance = nextDist;

    // Anchor zoom smoothly toward cursor ground hit
    if (anchorWorld) {
      const ratio = 1 - nextDist / prevDist;
      this.targetX += (anchorWorld.x - this.targetX) * ratio * 0.72;
      this.targetZ += (anchorWorld.z - this.targetZ) * ratio * 0.72;
    }

    // Zooming in very close gently looks down toward the working floor
    if (nextDist < 22 && this.targetPitch < (52 * Math.PI) / 180 && !this.snapEnabled) {
      this.targetPitch = THREE.MathUtils.lerp(this.targetPitch, (64 * Math.PI) / 180, 0.08);
    }

    // Hysteresis view-mode switching
    if (this.viewMode === 'station' && nextDist < ZOOM_ENTER_BUILDING) {
      this.viewMode = 'building';
      this.onAutoViewModeChange?.('building');
    } else if (this.viewMode === 'building' && nextDist > ZOOM_EXIT_TO_STATION) {
      this.viewMode = 'station';
      this.onAutoViewModeChange?.('station');
    }
  }

  focusPoint(x: number, z: number, distance?: number): void {
    this.targetX = x;
    this.targetZ = z;
    if (distance !== undefined) {
      this.targetDistance = THREE.MathUtils.clamp(distance, MIN_DISTANCE, MAX_DISTANCE);
    }
  }

  fitBounds(minX: number, minZ: number, maxX: number, maxZ: number): void {
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const spanX = Math.max(24, maxX - minX);
    const spanZ = Math.max(24, maxZ - minZ);
    const fovRad = (this.camera.fov * Math.PI) / 180;
    const tanHalf = Math.tan(fovRad / 2);
    const aspect = Math.max(0.5, this.camera.aspect);
    // Exact perspective framing for arbitrary macro stations (e.g. 560x528m Star Pyramid!)
    const distForZ = (spanZ * 0.62) / tanHalf;
    const distForX = (spanX * 0.62) / (tanHalf * aspect);
    const needed = Math.max(distForX, distForZ, Math.max(spanX, spanZ) * 1.15);
    this.targetX = cx;
    this.targetZ = cz;
    this.targetDistance = THREE.MathUtils.clamp(needed, 34, MAX_DISTANCE);
    if (this.targetDistance > ZOOM_EXIT_TO_STATION && this.viewMode !== 'station') {
      this.viewMode = 'station';
      this.onAutoViewModeChange?.('station');
    }
  }

  /** Raycast NDC pointer onto the horizontal plane of the current focus floor */
  intersectFocusPlane(ndcX: number, ndcY: number): THREE.Vector3 | null {
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(this.focusFloor * FLOOR_VISUAL_SPACING));
    const hit = new THREE.Vector3();
    return raycaster.ray.intersectPlane(plane, hit) ? hit : null;
  }

  update(dt: number, nowMs: number): void {
    const alpha = 1 - Math.exp(-14 * Math.min(dt, 0.05));
    this.curX = THREE.MathUtils.lerp(this.curX, this.targetX, alpha);
    this.curZ = THREE.MathUtils.lerp(this.curZ, this.targetZ, alpha);
    this.curY = THREE.MathUtils.lerp(this.curY, this.targetFloorY, alpha);
    this.curYaw = normalizeAngle(this.curYaw + shortestAngleDelta(this.curYaw, this.targetYaw) * alpha);
    this.curPitch = THREE.MathUtils.lerp(this.curPitch, this.targetPitch, alpha);
    this.curDistance = THREE.MathUtils.lerp(this.curDistance, this.targetDistance, alpha);

    this.applyCameraTransform();

    if (this.onTelemetryChange && nowMs - this.lastTelemetryTime > 90) {
      this.lastTelemetryTime = nowMs;
      this.onTelemetryChange({
        yawDeg: Math.round((this.curYaw * 180) / Math.PI) % 360,
        pitchDeg: Math.round((this.curPitch * 180) / Math.PI),
        distance: Math.round(this.curDistance),
      });
    }
  }

  private applyImmediate(): void {
    this.curX = this.targetX;
    this.curZ = this.targetZ;
    this.curY = this.targetFloorY;
    this.curYaw = this.targetYaw;
    this.curPitch = this.targetPitch;
    this.curDistance = this.targetDistance;
    this.applyCameraTransform();
  }

  private applyCameraTransform(): void {
    const horiz = Math.cos(this.curPitch) * this.curDistance;
    const vert = Math.sin(this.curPitch) * this.curDistance;
    // Camera sits offset by (+sin(yaw), +cos(yaw)) in XZ so yaw=0 looks North (-Z) with +X to the right
    const camX = this.curX + Math.sin(this.curYaw) * horiz;
    const camY = this.curY + vert;
    const camZ = this.curZ + Math.cos(this.curYaw) * horiz;

    this.camera.position.set(camX, camY, camZ);
    this.camera.lookAt(this.curX, this.curY, this.curZ);
  }
}
