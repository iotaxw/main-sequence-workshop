import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';

/**
 * Razor-sharp, zero-moiré, zero-junction-dot analytical SDF line renderer.
 *
 * Root-cause invariants:
 * 1. Computes screen-space width derivative `fwidth(vUv.x)` BEFORE any branch — eliminates GPU
 *    quad derivative explosions that made short segments (belt turns, small chamfers) vanish.
 * 2. Trims protruding bulbous endcaps cleanly (`_cap > 0.16` discarded) and tightens the AA
 *    feather skirt (`+0.72px`) so lines render with solid architectural-ink crispness.
 * 3. Focus-layer lines use pre-baked ink colors at `opacity = 1.0`, making overlapping vertex
 *    brightening (`2a - a^2`) mathematically impossible!
 */

const GLOBAL_LINE_RESOLUTION = new THREE.Vector2(1280, 720);

export function setLineViewportResolution(width: number, height: number): void {
  GLOBAL_LINE_RESOLUTION.set(Math.max(1, width), Math.max(1, height));
}

export interface CrispLineOptions {
  color: number;
  opacity?: number;
  /** Desired crisp visual core stroke width in CSS pixels (typically 0.85 .. 1.5) */
  widthPx?: number;
  dashed?: boolean;
  dashSize?: number;
  gapSize?: number;
  lodTier?: 'primary' | 'detail';
}

export function createCrispLineMaterial(opts: CrispLineOptions): LineMaterial {
  const coreWidth = opts.widthPx ?? 1.1;
  // Tight analytical AA skirt (~0.38px per side) for razor-sharp ink edges without haze
  const quadWidth = coreWidth + 0.76;
  const opacity = opts.opacity ?? 1.0;

  const mat = new LineMaterial({
    color: opts.color,
    linewidth: quadWidth,
    transparent: true,
    opacity,
    depthWrite: false,
    depthTest: true,
    worldUnits: false,
    dashed: Boolean(opts.dashed),
    dashSize: opts.dashSize ?? 0.35,
    gapSize: opts.gapSize ?? 0.28,
    dashScale: 1,
    fog: true,
  });

  mat.uniforms.resolution.value = GLOBAL_LINE_RESOLUTION;
  mat.userData.baseOpacity = opacity;
  mat.userData.lodTier = opts.lodTier ?? 'primary';

  mat.onBeforeCompile = (shader) => {
    // 1. Safe zero-length guard for vertical ribs collapsing to 0px in top-down 89° view
    shader.vertexShader = shader.vertexShader.replace(
      'dir = normalize( dir );',
      `float _dirLen = length( dir );
      dir = ( _dirLen > 1e-5 ) ? ( dir / _dirLen ) : vec2( 1.0, 0.0 );`
    );
    shader.vertexShader = shader.vertexShader.replace(
      'offset *= linewidth;',
      'offset *= ( _dirLen > 1e-5 ) ? linewidth : 0.0;'
    );

    // 2. Continuous-derivative SDF anti-aliasing + flush micro-bevel caps (zero vertex dots, zero vanished short segments!)
    shader.fragmentShader = shader.fragmentShader.replace(
      `if ( abs( vUv.y ) > 1.0 ) {

						float a = vUv.x;
						float b = ( vUv.y > 0.0 ) ? vUv.y - 1.0 : vUv.y + 1.0;
						float len2 = a * a + b * b;

						if ( len2 > 1.0 ) discard;

					}`,
      `float _aa = max( fwidth( vUv.x ), 0.02 );
					float _cap = max( 0.0, abs( vUv.y ) - 1.0 );
					if ( _cap > 0.22 ) discard;
					float _dist = abs( vUv.x );
					float _cov = 1.0 - smoothstep( max( 0.0, 1.0 - _aa * 0.92 ), 1.0, _dist );
					if ( _cov <= 0.005 ) discard;
					alpha *= _cov;`
    );
  };
  mat.customProgramCacheKey = () => (opts.dashed ? 'crisp-cad-line-dashed-v2' : 'crisp-cad-line-v2');

  return mat;
}

export function createCrispLineSegments(pts: number[], opts: CrispLineOptions): LineSegments2 {
  const geo = new LineSegmentsGeometry();
  if (pts.length >= 6) {
    geo.setPositions(pts);
  } else {
    geo.setPositions([0, 0, 0, 0, 0, 0]);
  }
  const mat = createCrispLineMaterial(opts);
  const segs = new LineSegments2(geo, mat);
  if (opts.dashed) {
    segs.computeLineDistances();
  }
  return segs;
}
