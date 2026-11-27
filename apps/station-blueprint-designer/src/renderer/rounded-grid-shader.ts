import * as THREE from 'three';

/**
 * Shapez 2 style local rounded-rectangle floor grid shader.
 * Keeps the drafting background completely clean, illuminating a crisp rounded-tile matrix
 * ONLY within the active cursor radius or active placement/selection footprint!
 */
export interface RoundedGridUniforms {
  uCursorWorld: { value: THREE.Vector2 };
  uCursorRadius: { value: number };
  uCellSize: { value: number };
  uCornerRadius: { value: number };
  uLineColor: { value: THREE.Color };
  uFillColor: { value: THREE.Color };
  uOpacity: { value: number };
  uFocusRect: { value: THREE.Vector4 }; // minX, minZ, maxX, maxZ
  uHasFocusRect: { value: number };
  uCursorActive: { value: number };
}

const VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  varying vec3 vWorldPos;

  uniform vec2 uCursorWorld;
  uniform float uCursorRadius;
  uniform float uCellSize;
  uniform float uCornerRadius;
  uniform vec3 uLineColor;
  uniform vec3 uFillColor;
  uniform float uOpacity;
  uniform vec4 uFocusRect;
  uniform float uHasFocusRect;
  uniform float uCursorActive;

  float sdRoundedBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + vec2(r);
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
  }

  void main() {
    vec2 wp = vWorldPos.xz;

    // Radial falloff around cursor
    float mask = 0.0;
    if (uCursorActive > 0.5) {
      float dist = length(wp - uCursorWorld);
      float radial = 1.0 - smoothstep(uCursorRadius * 0.25, uCursorRadius, dist);
      mask = max(mask, radial);
    }

    // Active footprint / box-select rect mask (with soft padding)
    if (uHasFocusRect > 0.5) {
      vec2 rCenter = (uFocusRect.xy + uFocusRect.zw) * 0.5;
      vec2 rHalf = (uFocusRect.zw - uFocusRect.xy) * 0.5;
      float dRect = sdRoundedBox(wp - rCenter, rHalf, uCellSize * 0.15);
      float rectMask = 1.0 - smoothstep(0.0, uCellSize * 2.5, dRect);
      mask = max(mask, rectMask * 1.15);
    }

    if (mask <= 0.005) discard;

    // Band-limiting against Nyquist moiré at oblique angles / far zoom
    vec2 cellFw = fwidth(wp / uCellSize);
    float maxCellFw = max(cellFw.x, cellFw.y);
    float nyquistFade = 1.0 - smoothstep(0.11, 0.34, maxCellFw);
    if (nyquistFade <= 0.005) discard;

    // Local cell coordinates [-0.5, +0.5]
    vec2 cellLocal = fract(wp / uCellSize) - 0.5;
    vec2 halfTile = vec2(0.425);
    float d = sdRoundedBox(cellLocal, halfTile, uCornerRadius);

    // Razor-sharp resolution-independent anti-aliased stroke at ALL zoom levels
    float aa = max(fwidth(d), 0.0008);
    float halfStroke = max(0.006, aa * 0.7);
    float border = 1.0 - smoothstep(max(0.0, halfStroke - aa * 0.7), halfStroke + aa * 0.7, abs(d));
    float interior = 1.0 - smoothstep(-aa * 0.8, aa * 0.8, d);

    float alpha = (border * 0.72 + interior * 0.09) * mask * nyquistFade * uOpacity;
    if (alpha <= 0.004) discard;

    vec3 col = mix(uFillColor, uLineColor, clamp(border * 1.2, 0.0, 1.0));
    gl_FragColor = vec4(col, alpha);
  }
`;

export function createRoundedGridOverlay(): {
  mesh: THREE.Mesh;
  uniforms: RoundedGridUniforms;
} {
  const uniforms: RoundedGridUniforms = {
    uCursorWorld: { value: new THREE.Vector2(0, 0) },
    uCursorRadius: { value: 7.5 },
    uCellSize: { value: 1.0 },
    uCornerRadius: { value: 0.14 },
    uLineColor: { value: new THREE.Color('#607a94') },
    uFillColor: { value: new THREE.Color('#1a2636') },
    uOpacity: { value: 0.56 },
    uFocusRect: { value: new THREE.Vector4(0, 0, 0, 0) },
    uHasFocusRect: { value: 0 },
    uCursorActive: { value: 0 },
  };

  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);

  const mat = new THREE.ShaderMaterial({
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 10;
  mesh.frustumCulled = false;
  mesh.visible = false;
  return { mesh, uniforms };
}
