import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';

/**
 * Motion-stable, angle-invariant, zero-junction-dot analytical SDF line renderer.
 *
 * Root-cause invariants:
 * 1. Computes rotationally-invariant Euclidean pixel derivative `length(vec2(dFdx(vUv.x), dFdy(vUv.x)))`
 *    BEFORE any branch — eliminates both GPU quad derivative explosions (vanishing short belt-turn
 *    segments) and L1 `fwidth` 1.414x thickness bias across viewing angles.
 * 2. Expands quad width by a full +2.2 CSS px AA skirt and centers a Nyquist-safe ~1.65 device-pixel
 *    analytical smoothstep ramp around `uEdgeRatio = coreWidth / quadWidth`, eliminating sub-pixel
 *    shimmering/crawling during continuous camera pan, orbit, and zoom (even at 1x pixel ratio).
 * 3. Smoothly tapers flush micro-bevel caps (`_cap` in [0.02, 0.22]) so joints have zero bulbous dots
 *    and zero hard-clipping flicker.
 * 4. Focus-layer lines use pre-baked ink colors at `opacity = 1.0`, making overlapping vertex
 *    brightening (`2a - a^2`) mathematically impossible.
 */

const GLOBAL_LINE_RESOLUTION = new THREE.Vector2(1280, 720);

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
  lodTier?: 'primary' | 'detail';
}

export function createCrispLineMaterial(opts: CrispLineOptions): LineMaterial {
  const coreWidth = Math.max(1.0, opts.widthPx ?? 1.25);
  // Generous +2.2px analytical AA skirt gives >= 1.65 device-pixel Nyquist transition band on 1x & 2x displays
  const quadWidth = coreWidth + 2.2;
  const edgeRatio = THREE.MathUtils.clamp(coreWidth / quadWidth, 0.2, 0.78);
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

    // Inject uniform declaration in fragment shader
    shader.fragmentShader = 'uniform float uEdgeRatio;\n' + shader.fragmentShader;

    // 2. Angle-invariant Euclidean derivative + Nyquist-safe smooth SDF + smooth flush caps
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
					float _halfAa = min( _px * 0.85, 1.0 - uEdgeRatio );
					float _cov = 1.0 - smoothstep( max( 0.0, uEdgeRatio - _halfAa ), min( 1.0, uEdgeRatio + _halfAa ), _dist );
					_cov *= _capCov;
					if ( _cov <= 0.005 ) discard;
					alpha *= _cov;`
    );
  };
  mat.customProgramCacheKey = () => (opts.dashed ? 'crisp-cad-line-dashed-v3' : 'crisp-cad-line-v3');

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
  segs.userData.rawPositions = pts;
  segs.userData.lineOpts = opts;
  return segs;
}
