import * as THREE from 'three';
import { getBuildableDef } from '../core/catalog';
import { FLOOR_VISUAL_SPACING, getBuildingSpatialIndex, packCellKey } from '../core/geometry';
import type { BlueprintDocument, PlacedBuilding } from '../core/types';
import type { CadThemePalette } from './theme';

export const BELT_CHUNK_SIZE_M = 64;

export function beltChunkCoord(v: number): number {
  return Math.floor(v / BELT_CHUNK_SIZE_M);
}

export function packBeltChunkKey(cx: number, cy: number): number {
  return (cx + 1024) * 2048 + (cy + 1024);
}

// Cardinal direction unit vectors: 0=+X(E), 1=+Y(S), 2=-X(W), 3=-Y(N)
const DIR_DX = [1, 0, -1, 0];
const DIR_DY = [0, 1, 0, -1];

/**
 * Determine straight (0), right turn (+1), or left turn (-1) for a belt cell using the
 * exact same neighbor-connectivity rules as `emitBeltDirectToBuffers` in `line-art.ts`.
 */
export function computeBeltLocalTurn(
  cellMap: Map<number, PlacedBuilding | PlacedBuilding[]> | undefined,
  b: PlacedBuilding
): -1 | 0 | 1 {
  if (!cellMap) return 0;
  const dx = DIR_DX[b.rotation];
  const dy = DIR_DY[b.rotation];

  const isBeltFeedingHere = (nx: number, ny: number, expectedRot: number): boolean => {
    const hit = cellMap.get(packCellKey(nx, ny));
    if (!hit) return false;
    if (Array.isArray(hit)) {
      for (let i = 0; i < hit.length; i++) {
        const nb = hit[i];
        const ndef = getBuildableDef(nb.type);
        if (!ndef || ndef.kind !== 'belt') continue;
        if (nb.rotation === expectedRot) return true;
      }
      return false;
    }
    const ndef = getBuildableDef(hit.type);
    return Boolean(ndef && ndef.kind === 'belt' && hit.rotation === expectedRot);
  };

  if (isBeltFeedingHere(b.x - dx, b.y - dy, b.rotation)) {
    return 0;
  }
  const fromLeftRot = (b.rotation + 1) % 4;
  const fromRightRot = (b.rotation + 3) % 4;
  const hasFromLeft = isBeltFeedingHere(b.x - DIR_DX[fromLeftRot], b.y - DIR_DY[fromLeftRot], fromLeftRot);
  const hasFromRight = isBeltFeedingHere(b.x - DIR_DX[fromRightRot], b.y - DIR_DY[fromRightRot], fromRightRot);
  if (hasFromLeft && !hasFromRight) return -1;
  if (hasFromRight && !hasFromLeft) return 1;
  return 0;
}

/** Pack (localTurn in {-1,0,1}, tier in {1,2,3}) into a lossless small integer float. */
export function packBeltStyle(localTurn: -1 | 0 | 1, tier: number): number {
  const clampedTier = tier >= 3 ? 3 : tier === 2 ? 2 : 1;
  return (localTurn + 1) * 4 + clampedTier;
}

const BELT_VERT_GLSL = /* glsl */ `
  attribute vec4 aBeltData;

  uniform float uFloorY;

  varying vec2 vLocal;
  varying float vTurn;
  varying float vTier;
  varying float vFogDepth;

  void main() {
    float cx = aBeltData.x;
    float cz = aBeltData.y;
    float rot = floor(aBeltData.z + 0.5);
    float packed = floor(aBeltData.w + 0.5);

    float turnIdx = floor(packed * 0.25);
    vTurn = turnIdx - 1.0;
    vTier = packed - turnIdx * 4.0;

    float lx = position.x;
    float lz = position.z;
    vLocal = vec2(lx, lz);

    float rx;
    float rz;
    if (rot < 0.5) {
      rx = lx;
      rz = lz;
    } else if (rot < 1.5) {
      rx = -lz;
      rz = lx;
    } else if (rot < 2.5) {
      rx = -lx;
      rz = -lz;
    } else {
      rx = lz;
      rz = -lx;
    }

    vec4 mvPos = modelViewMatrix * vec4(cx + rx, uFloorY + 0.036, cz + rz, 1.0);
    vFogDepth = -mvPos.z;
    gl_Position = projectionMatrix * mvPos;
  }
`;

const BELT_FRAG_GLSL = /* glsl */ `
  uniform vec3 uBedColor;
  uniform vec3 uRailMk1;
  uniform vec3 uRailMk2;
  uniform vec3 uRailMk3;
  uniform vec3 uChevColor;
  uniform float uOpacity;
  uniform float uDetailLod;
  uniform float uMicroLod;
  uniform float uIsFocus;
  uniform vec3 uFogColor;
  uniform float uFogDensity;

  varying vec2 vLocal;
  varying float vTurn;
  varying float vTier;
  varying float vFogDepth;

  float sdSegment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a;
    vec2 ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    return length(pa - ba * h);
  }

  float sdChevron(vec2 p, float ox, float sz) {
    float xL = ox - sz * 0.45;
    float xR = ox + sz * 0.48;
    float zH = sz * 0.48;
    vec2 tip = vec2(xR, 0.0);
    float d1 = sdSegment(p, vec2(xL, -zH), tip);
    float d2 = sdSegment(p, tip, vec2(xL, zH));
    return min(d1, d2);
  }

  void main() {
    vec2 p = vLocal;
    float px = max(length(vec2(dFdx(p.x), dFdy(p.x))), length(vec2(dFdx(p.y), dFdy(p.y))));
    px = max(px, 1e-4);

    vec3 railCol = vTier > 2.5 ? uRailMk3 : (vTier > 1.5 ? uRailMk2 : uRailMk1);

    // Scale-adaptive trace width: keeps 1m cool-silver belts crisp & readable at 800-1200m
    // while staying slightly softer than 100% pure-platinum machine outlines!
    float macroMix = smoothstep(0.09, 0.30, px);
    float traceHalfW = clamp(max(0.27, px * 0.56), 0.27, 0.45);

    float bedDist;
    float railDist;
    if (abs(vTurn) < 0.5) {
      bedDist = abs(p.y) - traceHalfW;
      railDist = abs(abs(p.y) - 0.27);
    } else {
      vec2 piv = vec2(0.5, vTurn > 0.0 ? 0.5 : -0.5);
      float rad = length(p - piv);
      bedDist = abs(rad - 0.5) - traceHalfW;
      railDist = min(abs(rad - 0.23), abs(rad - 0.77));
    }

    float aa = px * 0.72;
    float bedCov = 1.0 - smoothstep(-aa, aa, bedDist);

    // Non-focus floor fast silhouette path: gentle tinted trace, skips rail & chevron SDF math completely
    if (uIsFocus < 0.5) {
      float outAlpha = bedCov * uOpacity * 0.72;
      if (outAlpha < 0.008) discard;
      vec3 refCol = mix(uBedColor, railCol, 0.36);
      float fogF = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
      vec3 col = mix(refCol, uFogColor, clamp(fogF, 0.0, 1.0));
      gl_FragColor = vec4(col, outAlpha);
      return;
    }

    // Close range: cool recessed belt bed + crisp twin rails + directional chevrons.
    // Macro range: smoothly fuses into a refined cool-silver trace (~64% rail luminance) that stands out cleanly
    // over deep obsidian floors without competing with 100% bright platinum building silhouettes!
    vec3 macroTraceCol = mix(uBedColor, railCol, 0.64);
    vec3 col = mix(uBedColor, macroTraceCol, macroMix);
    float alpha = bedCov * mix(0.92, 0.86, macroMix);

    // Tier 1 / 2 / 3 speed chevrons (only evaluated at close range when microLod > 0.01)
    if (uMicroLod > 0.01 && macroMix < 0.92 && bedCov > 0.05) {
      float chevNyquist = smoothstep(0.18, 0.06, px);
      float chevStrength = uMicroLod * chevNyquist * (1.0 - macroMix);
      if (chevStrength > 0.01) {
        float cd;
        if (vTier < 1.5) {
          cd = sdChevron(p, 0.0, 0.22);
        } else if (vTier < 2.5) {
          cd = min(sdChevron(p, -0.09, 0.20), sdChevron(p, 0.11, 0.20));
        } else {
          cd = min(sdChevron(p, -0.16, 0.18), min(sdChevron(p, 0.0, 0.18), sdChevron(p, 0.16, 0.18)));
        }
        float chevHalfW = max(px * 0.52, 0.013);
        float chevCov = (1.0 - smoothstep(chevHalfW - px * 0.58, chevHalfW + px * 0.58, cd)) * chevStrength * 0.88;
        col = mix(col, uChevColor, chevCov);
        alpha = max(alpha, chevCov);
      }
    }

    // Crisp twin rails at close & mid range (smoothly hands off to macroTraceCol as px rises)
    float detailWeight = max(uDetailLod, 1.0 - macroMix);
    if (detailWeight > 0.01 && macroMix < 0.95) {
      float railFade = (1.0 - macroMix) * smoothstep(0.45, 0.14, px);
      if (railFade > 0.01) {
        float railHalfW = max(px * 0.66, 0.017);
        float railCov = (1.0 - smoothstep(railHalfW - px * 0.62, railHalfW + px * 0.62, railDist)) * railFade;
        col = mix(col, railCol, railCov);
        alpha = max(alpha, railCov);
      }
    }

    float finalAlpha = alpha * uOpacity;
    if (finalAlpha < 0.008) discard;

    float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
    col = mix(col, uFogColor, clamp(fogFactor, 0.0, 1.0));
    gl_FragColor = vec4(col, finalAlpha);
  }
`;

export function createBeltShaderMaterial(floor: number, palette: CadThemePalette): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: BELT_VERT_GLSL,
    fragmentShader: BELT_FRAG_GLSL,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
    uniforms: {
      uFloorY: { value: floor * FLOOR_VISUAL_SPACING },
      uBedColor: { value: new THREE.Color(palette.beltTrackFill) },
      uRailMk1: { value: new THREE.Color(palette.beltRailMk1) },
      uRailMk2: { value: new THREE.Color(palette.beltRailMk2) },
      uRailMk3: { value: new THREE.Color(palette.beltRailMk3) },
      uChevColor: { value: new THREE.Color(palette.beltArrow) },
      uOpacity: { value: 1.0 },
      uDetailLod: { value: 1.0 },
      uMicroLod: { value: 1.0 },
      uIsFocus: { value: 1.0 },
      uFogColor: { value: new THREE.Color(palette.bg) },
      uFogDensity: { value: palette.isLight ? 0.00008 : 0.00018 },
    },
  });
}

function createSharedBeltBaseQuad(): { pos: THREE.BufferAttribute; index: THREE.BufferAttribute } {
  // Single 1m x 1m horizontal quad centered at origin (4 vertices, 2 CCW triangles looking from +Y)
  const positions = new Float32Array([
    -0.5, 0, -0.5,
    -0.5, 0, 0.5,
    0.5, 0, 0.5,
    0.5, 0, -0.5,
  ]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  return {
    pos: new THREE.BufferAttribute(positions, 3),
    index: new THREE.BufferAttribute(indices, 1),
  };
}

const SHARED_BELT_QUAD = createSharedBeltBaseQuad();

interface BeltSpatialChunk {
  readonly key: number;
  readonly bounds: THREE.Box3;
  readonly geo: THREE.InstancedBufferGeometry;
  readonly mesh: THREE.Mesh;
  readonly count: number;
}

/**
 * Zero-upload spatial-chunked, frustum-culled, scale-adaptive analytic-SDF instanced renderer
 * for all conveyor belts on one floor:
 * - Each `64m x 64m` chunk owns a tiny static `InstancedBufferGeometry` sharing ONE compiled `ShaderMaterial`
 *   and `SHARED_BELT_QUAD` -> ZERO `bufferSubData` GPU uploads & ZERO CPU copies during pan, orbit, or zoom!
 * - Close up: crisp twin Mk.1/2/3 rails, recessed bed, smooth circular bends, and directional chevrons.
 * - Macro zoom-out: smoothly fuses into luminous Mk.1/2/3 PCB bus traces with adaptive width so belts stay
 *   crystal clear even at 800-1200m overview!
 * - Local edits rebuild ONLY the affected 1-2 `64m` chunks in sub-millisecond time.
 */
export class BeltInstancedFloorLayer {
  readonly floor: number;
  readonly root = new THREE.Group();
  readonly material: THREE.ShaderMaterial;

  private chunks = new Map<number, BeltSpatialChunk>();
  private totalBelts = 0;
  private lastVisibleInstances = 0;

  constructor(floor: number, palette: CadThemePalette) {
    this.floor = floor;
    this.material = createBeltShaderMaterial(floor, palette);
    this.root.visible = false;
  }

  get beltCount(): number {
    return this.totalBelts;
  }

  get chunkCount(): number {
    return this.chunks.size;
  }

  get visibleInstanceCount(): number {
    return this.lastVisibleInstances;
  }

  applyPalette(palette: CadThemePalette): void {
    const u = this.material.uniforms;
    (u.uBedColor.value as THREE.Color).setHex(palette.beltTrackFill);
    (u.uRailMk1.value as THREE.Color).setHex(palette.beltRailMk1);
    (u.uRailMk2.value as THREE.Color).setHex(palette.beltRailMk2);
    (u.uRailMk3.value as THREE.Color).setHex(palette.beltRailMk3);
    (u.uChevColor.value as THREE.Color).setHex(palette.beltArrow);
    (u.uFogColor.value as THREE.Color).setHex(palette.bg);
  }

  /**
   * Full or incremental per-chunk rebuild of belt instances on this floor.
   * When `dirtyChunkKeys` is omitted/null, rebuilds all chunks on this floor.
   * When `dirtyChunkKeys` is provided, rebuilds ONLY those 64m chunks (sub-millisecond local edit!).
   */
  rebuildFromDoc(doc: BlueprintDocument, dirtyChunkKeys: Set<number> | null = null): void {
    const idx = getBuildingSpatialIndex(doc.buildings);
    const floorBlds = idx.buildingsByFloor.get(this.floor);
    const cellMap = idx.buildingCellByFloor.get(this.floor);
    const baseY = this.floor * FLOOR_VISUAL_SPACING;

    if (!dirtyChunkKeys) {
      this.disposeAllChunks();
      if (!floorBlds || floorBlds.length === 0) {
        this.root.visible = false;
        return;
      }

      const grouped = new Map<number, PlacedBuilding[]>();
      for (let i = 0; i < floorBlds.length; i++) {
        const b = floorBlds[i];
        const def = getBuildableDef(b.type);
        if (!def || def.kind !== 'belt') continue;
        const ck = packBeltChunkKey(beltChunkCoord(b.x), beltChunkCoord(b.y));
        let list = grouped.get(ck);
        if (!list) {
          list = [];
          grouped.set(ck, list);
        }
        list.push(b);
      }

      for (const [ck, list] of grouped) {
        this.mountChunk(this.buildChunk(ck, list, cellMap, baseY));
      }
      return;
    }

    if (dirtyChunkKeys.size === 0) return;

    // Dispose ONLY dirty chunks
    for (const ck of dirtyChunkKeys) {
      const old = this.chunks.get(ck);
      if (old) {
        this.totalBelts -= old.count;
        this.root.remove(old.mesh);
        old.geo.dispose();
        this.chunks.delete(ck);
      }
    }

    const grouped = new Map<number, PlacedBuilding[]>();
    const floorChunks = idx.buildingsByFloorChunk.get(this.floor);
    if (floorChunks) {
      for (const ck of dirtyChunkKeys) {
        const list = floorChunks.get(ck);
        if (!list || list.length === 0) continue;
        const belts: PlacedBuilding[] = [];
        for (let i = 0; i < list.length; i++) {
          const b = list[i];
          const def = getBuildableDef(b.type);
          if (def?.kind === 'belt') belts.push(b);
        }
        if (belts.length > 0) grouped.set(ck, belts);
      }
    } else if (floorBlds) {
      for (let i = 0; i < floorBlds.length; i++) {
        const b = floorBlds[i];
        const def = getBuildableDef(b.type);
        if (!def || def.kind !== 'belt') continue;
        const ck = packBeltChunkKey(beltChunkCoord(b.x), beltChunkCoord(b.y));
        if (!dirtyChunkKeys.has(ck)) continue;
        let list = grouped.get(ck);
        if (!list) {
          list = [];
          grouped.set(ck, list);
        }
        list.push(b);
      }
    }

    for (const [ck, list] of grouped) {
      this.mountChunk(this.buildChunk(ck, list, cellMap, baseY));
    }
  }

  private mountChunk(chunk: BeltSpatialChunk): void {
    this.chunks.set(chunk.key, chunk);
    this.root.add(chunk.mesh);
    this.totalBelts += chunk.count;
  }

  private buildChunk(
    key: number,
    belts: PlacedBuilding[],
    cellMap: Map<number, PlacedBuilding | PlacedBuilding[]> | undefined,
    baseY: number
  ): BeltSpatialChunk {
    const data = new Float32Array(belts.length * 4);
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;

    for (let i = 0; i < belts.length; i++) {
      const b = belts[i];
      const def = getBuildableDef(b.type);
      const turn = computeBeltLocalTurn(cellMap, b);
      const off = i * 4;
      data[off] = b.x + 0.5;
      data[off + 1] = b.y + 0.5;
      data[off + 2] = b.rotation;
      data[off + 3] = packBeltStyle(turn, def?.tier ?? 1);
      if (b.x < minX) minX = b.x;
      if (b.y < minZ) minZ = b.y;
      if (b.x + 1 > maxX) maxX = b.x + 1;
      if (b.y + 1 > maxZ) maxZ = b.y + 1;
    }

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', SHARED_BELT_QUAD.pos);
    geo.setIndex(SHARED_BELT_QUAD.index);
    const attr = new THREE.InstancedBufferAttribute(data, 4);
    attr.setUsage(THREE.StaticDrawUsage);
    geo.setAttribute('aBeltData', attr);
    geo.instanceCount = belts.length;

    const bounds = new THREE.Box3(
      new THREE.Vector3(minX - 0.5, baseY - 0.5, minZ - 0.5),
      new THREE.Vector3(maxX + 0.5, baseY + 1.0, maxZ + 0.5)
    );
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.frustumCulled = false; // Exact per-chunk AABB culling handled in `syncVisible`
    mesh.renderOrder = 2;

    return {
      key,
      bounds,
      geo,
      mesh,
      count: belts.length,
    };
  }

  /**
   * Zero-allocation, zero-GPU-upload per-frame visibility & uniform sync!
   * Simply toggles each static 64m chunk's `mesh.visible` against the camera frustum.
   */
  syncVisible(
    frustum: THREE.Frustum,
    floorOpacity: number,
    isFocus: boolean,
    cameraDist: number,
    detailLod: number,
    microLod: number,
    fogColor: THREE.Color,
    fogDensity: number
  ): void {
    // Non-focus floor savings: hide distant non-focus belts cleanly (> 95m) while keeping station skeleton crisp
    if (this.totalBelts === 0 || floorOpacity <= 0.01 || (!isFocus && cameraDist > 95)) {
      this.root.visible = false;
      this.lastVisibleInstances = 0;
      return;
    }

    const u = this.material.uniforms;
    u.uOpacity.value = floorOpacity;
    u.uIsFocus.value = isFocus ? 1.0 : 0.0;
    u.uDetailLod.value = isFocus ? detailLod : 0.0;
    u.uMicroLod.value = isFocus ? microLod : 0.0;
    (u.uFogColor.value as THREE.Color).copy(fogColor);
    u.uFogDensity.value = fogDensity;

    const order = isFocus ? 2 : 1;
    let visBelts = 0;
    for (const chunk of this.chunks.values()) {
      const vis = frustum.intersectsBox(chunk.bounds);
      chunk.mesh.visible = vis;
      if (vis) {
        chunk.mesh.renderOrder = order;
        visBelts += chunk.count;
      }
    }

    this.lastVisibleInstances = visBelts;
    this.root.visible = visBelts > 0;
  }

  private disposeAllChunks(): void {
    for (const chunk of this.chunks.values()) {
      this.root.remove(chunk.mesh);
      chunk.geo.dispose();
    }
    this.chunks.clear();
    this.totalBelts = 0;
    this.lastVisibleInstances = 0;
  }

  dispose(): void {
    this.disposeAllChunks();
    this.material.dispose();
  }
}
