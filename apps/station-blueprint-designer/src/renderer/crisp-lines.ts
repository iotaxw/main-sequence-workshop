import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';

/**
 * Analytical screen-space anti-aliased line renderer (moiré-free replacement for aliased GL_LINES).
 * Uses Three.js LineSegments2 + patched LineMaterial with exact SDF sub-pixel edge coverage
 * and a safe zero-length projection guard for top-down flattened vertical ribs.
 */

const GLOBAL_LINE_RESOLUTION = new THREE.Vector2(1280, 720);

export function setLineViewportResolution(width: number, height: number): void {
  GLOBAL_LINE_RESOLUTION.set(Math.max(1, width), Math.max(1, height));
}

export interface CrispLineOptions {
  color: number;
  opacity?: number;
  /** Desired visual core stroke width in CSS pixels (typically 0.85 .. 1.65) */
  widthPx?: number;
  dashed?: boolean;
  dashSize?: number;
  gapSize?: number;
  lodTier?: 'primary' | 'detail';
}

export function createCrispLineMaterial(opts: CrispLineOptions): LineMaterial {
  const coreWidth = opts.widthPx ?? 1.15;
  // Expand ribbon quad slightly so the analytical SDF feather has ~0.65px smooth AA skirt on each side
  const quadWidth = coreWidth + 1.3;
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

  // Share one live resolution vector across all materials so resize() updates every line instantly!
  mat.uniforms.resolution.value = GLOBAL_LINE_RESOLUTION;
  mat.userData.baseOpacity = opacity;
  mat.userData.lodTier = opts.lodTier ?? 'primary';

  mat.onBeforeCompile = (shader) => {
    // 1. Safe zero-length guard: when a vertical rib flattens to 0px in top-down 89° view,
    //    never divide by zero (NaN) and collapse both body & endcaps cleanly to 0px!
    shader.vertexShader = shader.vertexShader.replace(
      'dir = normalize( dir );',
      `float _dirLen = length( dir );
      dir = ( _dirLen > 1e-5 ) ? ( dir / _dirLen ) : vec2( 1.0, 0.0 );`
    );
    shader.vertexShader = shader.vertexShader.replace(
      'offset *= linewidth;',
      'offset *= ( _dirLen > 1e-5 ) ? linewidth : 0.0;'
    );

    // 2. True analytical sub-pixel SDF anti-aliasing across BOTH side edges (vUv.x) and rounded endcaps!
    shader.fragmentShader = shader.fragmentShader.replace(
      `if ( abs( vUv.y ) > 1.0 ) {

						float a = vUv.x;
						float b = ( vUv.y > 0.0 ) ? vUv.y - 1.0 : vUv.y + 1.0;
						float len2 = a * a + b * b;

						if ( len2 > 1.0 ) discard;

					}`,
      `float _dist = ( abs( vUv.y ) > 1.0 )
						? length( vec2( vUv.x, ( vUv.y > 0.0 ) ? ( vUv.y - 1.0 ) : ( vUv.y + 1.0 ) ) )
						: abs( vUv.x );
					float _aa = max( fwidth( _dist ), 0.02 );
					float _cov = 1.0 - smoothstep( max( 0.0, 1.0 - _aa * 1.15 ), 1.0, _dist );
					if ( _cov <= 0.004 ) discard;
					alpha *= _cov;`
    );
  };
  mat.customProgramCacheKey = () => (opts.dashed ? 'crisp-cad-line-dashed-v1' : 'crisp-cad-line-v1');

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
