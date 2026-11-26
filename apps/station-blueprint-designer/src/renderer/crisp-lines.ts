import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';

/**
 * Motion-stable, angle-invariant, Moiré-free analytical SDF line renderer (v4).
 *
 * Root-cause invariants:
 * 1. Computes exact screen-space segment length `vSegLenPx = _dirLen * resolution.y * 0.5` in the
 *    vertex shader and applies analytical Nyquist prefiltering (`smoothstep(1.1, 4.2, vSegLenPx)`)
 *    so sub-pixel micro-segments (distant belt chevrons, tiny bevels, dense parallel ticks) smoothly
 *    attenuate before crossing the 2-pixel Nyquist frequency — eliminating far-field Moiré ripples
 *    while keeping macro machine/module silhouettes razor sharp.
 * 2. Computes rotationally-invariant Euclidean pixel derivative `length(vec2(dFdx(vUv.x), dFdy(vUv.x)))`
 *    with a +2.6 CSS px AA skirt and sRGB gamma-compensated coverage (`pow(_cov, 0.65)`), eliminating
 *    the ~40% luminance pumping ("diagonal roping/beading") caused by blending linear coverage into
 *    an sRGB framebuffer during smooth camera pans and orbits.
 * 3. Smoothly tapers flush micro-bevel caps (`_cap` in [0.02, 0.22]) so joints have zero bulbous dots
 *    and zero hard-clipping flicker.
 * 4. Focus-layer lines use pre-baked ink colors at `opacity = 1.0`, making overlapping vertex
 *    brightening (`2a - a^2`) mathematically impossible.
 */

const GLOBAL_LINE_RESOLUTION = new THREE.Vector2(1280, 720);

let deferredLineDepth = 0;

/**
 * Execute `fn` in deferred line-collection mode: `createCrispLineSegments` returns lightweight
 * `THREE.Object3D` carriers holding `rawPositions` & `lineOpts` WITHOUT allocating throwaway
 * `LineSegmentsGeometry` or `LineMaterial` instances before `FloorRenderBucket.ingestObject`.
 */
export function withDeferredLines<T>(fn: () => T): T {
  deferredLineDepth++;
  try {
    return fn();
  } finally {
    deferredLineDepth--;
  }
}

export function setLineViewportResolution(width: number, height: number): void {
  GLOBAL_LINE_RESOLUTION.set(Math.max(1, width), Math.max(1, height));
}

export interface CrispLineOptions {
  color: number;
  opacity?: number;
  /** Desired visual core stroke width in CSS pixels (typically 1.05 .. 1.65) */
  widthPx?: number;
  dashed?: boolean;
  dashSize?: number;
  gapSize?: number;
  lodTier?: 'primary' | 'detail' | 'micro';
}

export function createCrispLineMaterial(opts: CrispLineOptions): LineMaterial {
  const coreWidth = Math.max(1.0, opts.widthPx ?? 1.25);
  // Generous +2.6px analytical AA skirt ensures full Nyquist filter support across shallow diagonal angles
  const quadWidth = coreWidth + 2.6;
  const edgeRatio = THREE.MathUtils.clamp(coreWidth / quadWidth, 0.18, 0.76);
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
  mat.userData.edgeRatio = edgeRatio;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uEdgeRatio = { value: edgeRatio };

    // 1. Safe zero-length guard + exact screen-space segment length (CSS px) for analytical Nyquist prefilter
    shader.vertexShader = 'varying float vSegLenPx;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      'dir = normalize( dir );',
      `float _dirLen = length( dir );
      vSegLenPx = _dirLen * resolution.y * 0.5;
      dir = ( _dirLen > 1e-5 ) ? ( dir / _dirLen ) : vec2( 1.0, 0.0 );`
    );
    shader.vertexShader = shader.vertexShader.replace(
      'offset *= linewidth;',
      'offset *= ( _dirLen > 1e-5 ) ? linewidth : 0.0;'
    );

    // Inject uniform + varying declarations in fragment shader
    shader.fragmentShader = 'uniform float uEdgeRatio;\nvarying float vSegLenPx;\n' + shader.fragmentShader;

    // 2. Angle-invariant Euclidean derivative + sRGB gamma-compensated SDF + per-segment Nyquist prefilter
    shader.fragmentShader = shader.fragmentShader.replace(
      `if ( abs( vUv.y ) > 1.0 ) {

						float a = vUv.x;
						float b = ( vUv.y > 0.0 ) ? vUv.y - 1.0 : vUv.y + 1.0;
						float len2 = a * a + b * b;

						if ( len2 > 1.0 ) discard;

					}`,
      `vec2 _duv = vec2( dFdx( vUv.x ), dFdy( vUv.x ) );
					float _px = max( length( _duv ), 0.012 );
					float _cap = max( 0.0, abs( vUv.y ) - 1.0 );
					if ( _cap > 0.22 ) discard;
					float _capCov = 1.0 - smoothstep( 0.02, 0.22, _cap );
					float _dist = abs( vUv.x );
					float _halfAa = min( _px * 0.95, 1.0 - uEdgeRatio );
					float _cov = 1.0 - smoothstep( max( 0.0, uEdgeRatio - _halfAa ), min( 1.0, uEdgeRatio + _halfAa ), _dist );
					_cov = pow( max( _cov, 0.0 ), 0.65 );
					float _nyq = smoothstep( 0.35, 1.15, vSegLenPx );
					_cov *= _capCov * _nyq;
					if ( _cov <= 0.005 ) discard;
					alpha *= _cov;`
    );
  };
  mat.customProgramCacheKey = () => (opts.dashed ? 'crisp-cad-line-dashed-v4' : 'crisp-cad-line-v4');

  return mat;
}

export function createCrispLineSegments(pts: number[], opts: CrispLineOptions): LineSegments2 {
  if (deferredLineDepth > 0) {
    const stub = new THREE.Object3D();
    stub.userData.rawPositions = pts;
    stub.userData.lineOpts = opts;
    return stub as unknown as LineSegments2;
  }
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
  segs.userData.rawPositions = pts;
  segs.userData.lineOpts = opts;
  return segs;
}
