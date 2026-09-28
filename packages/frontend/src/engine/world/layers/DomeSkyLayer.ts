import * as THREE from 'three';
import { getObserverSceneAnchor } from '../../scene/sky';
import { useStore, isDomeView } from '../../../store/useStore';
import type { FrameContext, Layer, LayerContext } from '../../render/Layer';

/** Sky sphere radius — inside the far plane (1000); the camera is always at its centre. */
const SKY_RADIUS = 50;

const SKY_VERT = /* glsl */ `
varying vec3 vWorldPos;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

/**
 * Analytic ground‑level sky + sea, in ONE fragment shader (no second pass):
 *  - `skyColor(dir)`: horizon→zenith gradient, day/night by sun elevation, warm
 *    twilight lobe toward the sun near the horizon.
 *  - Upward rays render the sky. Downward rays render an ambient, auto‑animated
 *    Gerstner‑wave sea that **Fresnel‑reflects `skyColor()`** at the reflected
 *    direction (+ sun glitter) — the "reflection" is just the sky function sampled
 *    again, so no reflection camera / render target is needed.
 * The sea is purely visual: it animates from `uTime` and nothing interacts with it.
 * `cameraPosition` is auto‑injected by three for ShaderMaterial.
 */
const SKY_FRAG = /* glsl */ `
uniform vec3  uUp;      // observer zenith, scene frame
uniform vec3  uSunDir;  // sun unit vector, scene frame
uniform float uTime;    // seconds (wall‑clock accumulator) — drives the waves

varying vec3 vWorldPos;

const vec3  SPIN_AXIS    = vec3(0.0, 1.0, 0.0); // scene‑frame Earth spin axis (TEME +Z)
const float EYE_HEIGHT_M = 2.0;                  // artistic eye height above the sea

// Pure upper‑hemisphere sky colour for any direction. No below‑horizon term — that's
// the sea (below). Reused by the sea as its reflection source.
vec3 skyColor(vec3 dir) {
  float elev    = dot(dir, uUp);
  float sunElev = dot(uSunDir, uUp);
  float dayness = smoothstep(-0.18, 0.10, sunElev);

  vec3 zenithDay    = vec3(0.18, 0.42, 0.82);
  vec3 horizonDay   = vec3(0.62, 0.76, 0.92);
  vec3 zenithNight  = vec3(0.012, 0.020, 0.055);
  vec3 horizonNight = vec3(0.040, 0.060, 0.130);
  vec3 zenithColor  = mix(zenithNight, zenithDay, dayness);
  vec3 horizonColor = mix(horizonNight, horizonDay, dayness);

  float g = smoothstep(0.0, 0.55, max(elev, 0.0));
  vec3 col = mix(horizonColor, zenithColor, g);

  // Warm twilight glow toward the sun, civil‑twilight gated (sunElev = sin altitude).
  float towardSun        = max(dot(dir, normalize(uSunDir)), 0.0);
  float twilightWindow   = smoothstep(-0.12, -0.02, sunElev) * (1.0 - smoothstep(0.02, 0.12, sunElev));
  float horizonProximity = 1.0 - smoothstep(0.0, 0.32, abs(elev));
  col += vec3(1.0, 0.46, 0.20) * (pow(towardSun, 3.0) * twilightWindow * horizonProximity) * 0.6;
  return col;
}

// One Gerstner wave's contribution to the surface normal (height‑field form):
// returns (∂east, up‑term, ∂north) accumulated into the tangent‑frame normal.
vec3 waveContribution(vec2 p, vec2 dir, float L, float A, float Q, float spd, float flatten) {
  vec2  D  = normalize(dir);
  float k  = 6.2831853 / L;
  float ph = k * dot(D, p) + uTime * spd;
  float WA = k * A * flatten;
  return vec3(-D.x * WA * cos(ph), -Q * WA * sin(ph), -D.y * WA * cos(ph));
}

// Ambient Gerstner sea for a below‑horizon ray (elev < 0): Fresnel‑reflects the sky.
vec3 seaColor(vec3 viewDir, float elev, vec3 east, vec3 north) {
  float down = max(-elev, 1e-4);
  float t    = EYE_HEIGHT_M / down;     // metres along the ray to the water
  vec3  hit  = viewDir * t;             // offset from the eye, metres
  vec2  p    = vec2(dot(hit, east), dot(hit, north));

  // Flatten waves toward the horizon (far + grazing) to kill shimmer/aliasing.
  float flatten = smoothstep(0.0, 0.14, -elev);

  vec3 g = vec3(0.0, 1.0, 0.0);
  g += waveContribution(p, vec2( 1.0,  0.6), 6.0, 0.100, 0.5, 0.9, flatten);
  g += waveContribution(p, vec2(-0.7,  1.0), 3.1, 0.050, 0.5, 1.2, flatten);
  g += waveContribution(p, vec2( 0.3, -1.0), 1.7, 0.025, 0.4, 1.6, flatten);
  g += waveContribution(p, vec2(-1.0, -0.4), 0.9, 0.012, 0.3, 2.1, flatten);
  vec3 N = normalize(east * g.x + uUp * g.y + north * g.z);

  vec3  V       = -viewDir;
  float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  vec3  reflDir = reflect(viewDir, N);
  vec3  refl    = skyColor(reflDir);

  float sunElev = dot(uSunDir, uUp);
  float dayness = smoothstep(-0.18, 0.10, sunElev);
  vec3  deep    = mix(vec3(0.020, 0.050, 0.075), vec3(0.06, 0.16, 0.21), dayness);

  vec3 color = mix(deep, refl, clamp(fresnel + 0.06, 0.0, 1.0));

  float glitter = pow(max(dot(reflDir, normalize(uSunDir)), 0.0), 120.0);
  float sunUp   = smoothstep(-0.05, 0.10, sunElev);
  color += vec3(1.0, 0.9, 0.7) * glitter * sunUp * 0.8;
  return color;
}

// Hash + value noise, sampled on a circle so the ridgeline is seamless around the
// horizon (no seam at due north) and irregular — not a periodic "frequency map".
float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Procedural ridgeline silhouette height (sin of elevation) vs azimuth. Ridged fBm of
// value noise → irregular, sharp-crested distant mountains (not dunes, not ripples).
float mountainTop(float az) {
  vec2 q = vec2(cos(az), sin(az)) * 5.0;     // circle radius ~ ridge count around horizon
  float h = 0.0;
  float amp = 0.5;
  for (int k = 0; k < 5; k++) {
    float n = vnoise2(q);
    h += amp * (1.0 - abs(2.0 * n - 1.0));   // ridged: sharp crests, cut valleys
    q *= 2.0;
    amp *= 0.5;
  }
  h = pow(clamp(h, 0.0, 1.0), 1.6);          // sharpen peaks / flatten valleys
  return mix(0.006, 0.038, h);               // toned-down height (~0.3°..2.2°)
}

void main() {
  vec3  viewDir = normalize(vWorldPos - cameraPosition);
  float elev    = dot(viewDir, uUp);   // 1 = zenith, 0 = horizon, <0 = below

  // Local tangent basis (azimuth + wave coords); pole‑safe.
  vec3 east = cross(SPIN_AXIS, uUp);
  if (dot(east, east) < 1e-6) east = cross(vec3(1.0, 0.0, 0.0), uUp);
  east = normalize(east);
  vec3 north = normalize(cross(uUp, east));

  // Base scene: sky above the horizon, ambient sea below.
  vec3 color = (elev >= 0.0) ? skyColor(viewDir) : seaColor(viewDir, elev, east, north);

  // ── Procedural horizon mountains — a low silhouette covering the seam ────────
  // The ridge rises ~1‑3° above the horizon and its foot sits ~3° BELOW it, fading
  // into the sea (perceived "submerged / emerging from the water" base).
  const float FOOT = -0.05;                         // submerged foot (sin ≈ -3°)
  float az  = atan(dot(viewDir, east), dot(viewDir, north));
  float top = mountainTop(az);
  float ridge     = smoothstep(top, top - 0.004, elev);  // 1 below the ridgeline
  float depthFade = smoothstep(FOOT, 0.0, elev);         // fade out below the waterline
  float mtnAlpha  = ridge * depthFade;

  float ds = smoothstep(-0.18, 0.10, dot(uSunDir, uUp));
  vec3  mountainColor = mix(vec3(0.015, 0.022, 0.035), vec3(0.10, 0.13, 0.17), ds);
  // Submerged part (below the waterline) reads as under the sea: blend toward water.
  float submerge = clamp(-elev / -FOOT, 0.0, 1.0) * step(elev, 0.0);
  mountainColor = mix(mountainColor, color, submerge * 0.7);

  color = mix(color, mountainColor, mtnAlpha);

  gl_FragColor = vec4(color, 1.0);
}
`;

/**
 * The dome planetarium sky **and sea** — a camera‑centred sphere shown **only in dome
 * mode**, replacing the from‑space Earth/atmosphere backdrop (which the {@link EarthLayer}
 * hides in dome mode). Upper hemisphere = gradient sky; lower hemisphere = an ambient
 * Gerstner sea that Fresnel‑reflects that same sky; a low procedural mountain ridge
 * straddles the horizon (submerged foot fading into the sea) to cover the seam. Drawn
 * first (`renderOrder = -1000`, depth test off) so stars, satellites and the compass
 * render on top. Non‑critical; owns + disposes its own GL.
 *
 * Why a dedicated sky: in dome mode the camera sits ~16 m above the surface, *inside* the
 * from‑space atmosphere shell, where its raymarch (built for camera‑outside viewing) plus
 * the 63 km near plane produce a black gap + uneven limb band. This analytic sky has no
 * such regime problems.
 */
export class DomeSkyLayer implements Layer {
  readonly name = 'dome-sky';
  readonly critical = false;

  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private mesh: THREE.Mesh | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private readonly up = new THREE.Vector3(0, 1, 0); // per-frame scratch (no alloc)
  /** Wall-clock seconds (accumulated from frame.delta) driving the wave phase. */
  private waveTime = 0;

  init(ctx: LayerContext): void {
    this.scene = ctx.scene;
    this.camera = ctx.camera;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uUp: { value: new THREE.Vector3(0, 1, 0) },
        uSunDir: { value: new THREE.Vector3(1, 0, 0) },
        uTime: { value: 0 },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide, // camera is inside the sphere
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    const geo = new THREE.SphereGeometry(SKY_RADIUS, 32, 16);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.renderOrder = -1000;   // background: drawn before everything
    this.mesh.frustumCulled = false; // always centred on the camera
    this.mesh.visible = false;
    ctx.scene.add(this.mesh);
  }

  update(frame: FrameContext): void {
    if (!this.mesh || !this.material || !this.camera) return;

    // Show only while actually standing in the dome view; joyride/fly-to out of dome
    // (cameraMode !== 'free') hides the sky so the normal space view is unobstructed.
    const dome = isDomeView(useStore.getState());
    this.mesh.visible = dome;
    if (!dome) return;

    // Skybox: keep the dome centred on the eye so it never clips or approaches.
    this.mesh.position.copy(this.camera.position);

    const loc = useStore.getState().observerLocation;
    if (loc) {
      this.up.copy(getObserverSceneAnchor(loc.lat, loc.lon, loc.alt, frame.date).up);
    } else {
      this.up.set(0, 1, 0);
    }
    this.material.uniforms.uUp.value.copy(this.up);
    this.material.uniforms.uSunDir.value.copy(frame.sunDirectionECI);

    // Advance the (ambient, non-interactive) waves on wall-clock time so they're
    // smooth regardless of sim-time scrubbing/scaling.
    this.waveTime += frame.delta;
    this.material.uniforms.uTime.value = this.waveTime;
  }

  dispose(): void {
    if (this.mesh) {
      this.scene?.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    this.material?.dispose();
    this.mesh = null;
    this.material = null;
    this.scene = null;
    this.camera = null;
  }
}
