/**
 * EarthRenderer — textured Earth sphere + cloud layer + atmosphere rim glow.
 *
 * COORDINATE CONVENTION (critical for satellite alignment):
 *   The scene is in the ECI (inertial) frame.  Earth mesh rotates by
 *   GAST each frame so its texture aligns with real geography.
 *
 *   Satellites are in ECI (TEME) coordinates — placed in the scene via:
 *     mesh.position.set(eci.x, eci.z, -eci.y)
 *   (Three.js is Y-up; ECI/TEME is Z-up toward the North Pole.)
 *
 * All GLSL is inlined as template literals — no .glsl imports.
 *
 * ATMOSPHERE: Single-pass analytical raymarching against concentric spheres.
 * One draw call replaces the previous 148-shell stack.
 */
import * as THREE from 'three';
import { KtxTextureLoader } from './textures/KtxTextureLoader';
import { TEXTURE_URLS } from './textures/texture-manifest';

const ATM_INNER_RADIUS = 1.0;   // start at the planet surface
const ATM_OUTER_RADIUS = 1.12;  // extend well out for visible limb glow
const ATM_RAY_STEPS = 24;       // a few extra steps for the wider shell

// ─────────────────────────────────────────────────────────────────────────────
// Earth surface shaders
// ─────────────────────────────────────────────────────────────────────────────
const EARTH_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vWorldPos;

void main() {
  vUv = uv;
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const EARTH_FRAG = /* glsl */ `
uniform sampler2D uDayMap;
uniform sampler2D uNightMap;
uniform sampler2D uNormalMap;
uniform sampler2D uSpecularMap;
uniform vec3 uSunDirection;
uniform vec3 uCameraPos;

varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vWorldPos;

void main() {
  vec3 geomN = normalize(vNormal);
  vec3 dPdx  = dFdx(vWorldPos);
  vec3 dPdy  = dFdy(vWorldPos);
  vec2 dUVdx = dFdx(vUv);
  vec2 dUVdy = dFdy(vUv);
  float det  = dUVdx.x * dUVdy.y - dUVdx.y * dUVdy.x;
  vec3 T = (dUVdy.y * dPdx - dUVdx.y * dPdy) / det;
  T = normalize(T - dot(T, geomN) * geomN);
  vec3 B = cross(geomN, T);
  mat3 TBN = mat3(T, B, geomN);

  float height  = texture2D(uNormalMap, vUv).r;
  float heightX = texture2D(uNormalMap, vUv + dUVdx).r;
  float heightY = texture2D(uNormalMap, vUv + dUVdy).r;
  vec3 bumpNormal = normalize(vec3(
    (height - heightX) * 7.0,
    (height - heightY) * 7.0,
    1.0
  ));
  vec3 N = normalize(TBN * bumpNormal);

  vec3 sunDir  = normalize(uSunDirection);
  vec3 viewDir = normalize(uCameraPos - vWorldPos);
  float NdotL  = dot(N, sunDir);
  float geomNdotL = dot(geomN, sunDir);
  float NdotV = max(dot(N, viewDir), 0.0);
  float horizon = pow(1.0 - max(dot(geomN, viewDir), 0.0), 2.3);

  float dayBlend = smoothstep(-0.22, 0.18, geomNdotL);
  float lambert = max(NdotL, 0.0);
  float twilight = smoothstep(-0.18, 0.04, geomNdotL) * (1.0 - smoothstep(0.04, 0.28, geomNdotL));

  vec3 dayColor   = texture2D(uDayMap,   vUv).rgb;
  vec3 nightColor = texture2D(uNightMap, vUv).rgb;
  float specMask = texture2D(uSpecularMap, vUv).r;

  vec3 ambient = dayColor * vec3(0.07, 0.09, 0.13);
  vec3 litDay = dayColor * (0.18 + 0.82 * lambert) + ambient;
  litDay += dayColor * vec3(0.18, 0.08, 0.03) * twilight;

  vec3 limbColor = mix(vec3(1.0, 0.60, 0.24), vec3(0.40, 0.70, 1.0), smoothstep(-0.05, 0.25, geomNdotL));
  litDay += limbColor * horizon * smoothstep(-0.18, 0.30, geomNdotL) * 0.22;

  float cityBlend = 1.0 - smoothstep(-0.14, 0.06, geomNdotL);
  vec3 cityLights = nightColor * cityBlend * (2.0 + 0.5 * horizon);
  vec3 color = mix(cityLights, litDay, dayBlend);

  vec3 halfDir = normalize(sunDir + viewDir);
  float specular = pow(max(dot(N, halfDir), 0.0), mix(34.0, 110.0, specMask));
  float fresnel = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);
  vec3 specularColor = mix(vec3(0.30, 0.42, 0.58), vec3(0.95, 0.98, 1.0), fresnel);
  color += specularColor * specular * specMask * lambert * (0.35 + 1.7 * fresnel);

  vec3 hazeColor = mix(vec3(1.0, 0.72, 0.42), vec3(0.56, 0.76, 1.0), smoothstep(-0.06, 0.24, geomNdotL));
  float hazeBase = 0.08 * smoothstep(-0.18, 0.30, geomNdotL);
  float hazeLimb = pow(horizon, 0.85) * smoothstep(-0.12, 0.32, geomNdotL);
  float haze = hazeBase + hazeLimb * 0.34;
  color = mix(color, hazeColor, haze);
  color += hazeColor * (hazeBase * 0.03 + hazeLimb * 0.08);

  color += vec3(0.02, 0.05, 0.10) * dayBlend;

  gl_FragColor = vec4(color, 1.0);
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// Cloud shaders
// ─────────────────────────────────────────────────────────────────────────────
const CLOUD_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormal;

void main() {
  vUv = uv;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}
`;

const CLOUD_FRAG = /* glsl */ `
uniform sampler2D uCloudMap;
uniform vec3 uSunDirection;

varying vec2 vUv;
varying vec3 vNormal;

void main() {
  float cloudAlpha = texture2D(uCloudMap, vUv).r;

  vec3  sunDir = normalize(uSunDirection);
  vec3  N      = normalize(vNormal);
  float NdotL  = dot(N, sunDir);

  float nightFade = smoothstep(-0.15, 0.10, NdotL);
  float lit = max(NdotL, 0.0);

  vec3 shadowColor = vec3(0.58, 0.63, 0.80);
  vec3 cloudColor  = mix(shadowColor, vec3(1.0), smoothstep(-0.10, 0.25, NdotL));

  float termFrac  = smoothstep(-0.12, 0.0, NdotL) * (1.0 - smoothstep(0.0, 0.32, NdotL));
  cloudColor      = mix(cloudColor, vec3(1.0, 0.70, 0.38), termFrac * 0.65);

  cloudColor *= lit * 0.85 + 0.15;

  gl_FragColor = vec4(cloudColor, cloudAlpha * nightFade);
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// Raymarched atmosphere — single shell, all math in fragment shader
// ─────────────────────────────────────────────────────────────────────────────
const ATM_VERT = /* glsl */ `
varying vec3 vWorldPos;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos  = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const ATM_FRAG = /* glsl */ `
uniform vec3  uSunDirection;
uniform vec3  uCameraPos;
uniform float uInnerRadius;
uniform float uOuterRadius;
uniform float uStrength;

varying vec3 vWorldPos;

// ── Ray-sphere intersection ─────────────────────────────────────────────────
vec2 raySphere(vec3 ro, vec3 rd, float radius) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - radius * radius;
  float disc = b * b - c;
  if (disc < 0.0) return vec2(-1.0);
  float sq = sqrt(disc);
  return vec2(-b - sq, -b + sq);
}

void main() {
  vec3 rayOrigin = uCameraPos;
  vec3 rayDir    = normalize(vWorldPos - uCameraPos);
  vec3 sunDir    = normalize(uSunDirection);

  // Intersect the view ray with the atmosphere envelope
  vec2 outerHit = raySphere(rayOrigin, rayDir, uOuterRadius);
  if (outerHit.y < 0.0) discard;

  // Does the ray hit the planet body?
  vec2 innerHit = raySphere(rayOrigin, rayDir, uInnerRadius);
  bool hitsGround = innerHit.x > 0.0;

  float tStart = max(0.0, outerHit.x);
  float tEnd   = outerHit.y;
  if (hitsGround) {
    tEnd = innerHit.x;
  }
  if (tStart >= tEnd) discard;

  // ── Raymarch ────────────────────────────────────────────────────────────
  // We accumulate optical depth along the ray, then use Beer-Lambert to
  // convert it to a nonlinear brightness.  With additive blending only RGB
  // matters (alpha is ignored), so the output is simply the atmosphere
  // luminance to be added on top of whatever is behind.
  const int STEPS = ${ATM_RAY_STEPS};
  float stepSize  = (tEnd - tStart) / float(STEPS);
  float thickness = uOuterRadius - uInnerRadius;

  vec3  weightedColor = vec3(0.0); // density-weighted colour sum
  float totalDensity  = 0.0;      // integrated density (optical depth)

  for (int i = 0; i < STEPS; i++) {
    float t = tStart + (float(i) + 0.5) * stepSize;
    vec3  samplePos = rayOrigin + rayDir * t;
    float altitude  = length(samplePos);

    // Normalised height: 0 at planet surface, 1 at outer edge
    float h = clamp((altitude - uInnerRadius) / thickness, 0.0, 1.0);

    // Density: exponential falloff with a gentler scale height so
    // free-space rays (tangent to the limb) still accumulate meaningfully.
    float density = exp(-h * 3.8);

    // Direction from Earth centre at this sample
    vec3 sampleDir = samplePos / altitude;
    float sunAngle = dot(sampleDir, sunDir);

    // ── Colour ramp ─────────────────────────────────────────────────────
    vec3 dayColor      = vec3(0.25, 0.55, 1.00);
    vec3 twilightColor = vec3(0.80, 0.30, 0.06);
    vec3 nightColor    = vec3(0.03, 0.04, 0.14);

    vec3 color;
    if (sunAngle > 0.15) {
      color = dayColor;
    } else if (sunAngle > -0.15) {
      float tw = (sunAngle + 0.15) / 0.30;
      color = mix(twilightColor, dayColor, tw);
    } else {
      float tw = smoothstep(-0.5, -0.15, sunAngle);
      color = mix(nightColor, twilightColor, tw);
    }

    // Sunward brightness modulation
    float dayFactor = smoothstep(-0.40, 0.10, sunAngle);
    float localWeight = density * mix(0.06, 0.55, dayFactor);

    weightedColor += color * localWeight;
    totalDensity  += density;
  }

  // ── Beer-Lambert → nonlinear brightness ───────────────────────────────
  // τ = totalDensity * stepSize gives raw optical depth along the ray.
  // Beer-Lambert opacity: 1 - exp(-τ * σ).
  // This is the key nonlinear curve: short paths → near-zero brightness,
  // long grazing paths → saturating glow.  No linear blowout.
  float tau = totalDensity * stepSize;
  float scatter = 1.0 - exp(-tau * uStrength);

  // Average colour along the ray, weighted by density
  vec3 avgColor = (totalDensity > 0.001)
    ? weightedColor / totalDensity
    : vec3(0.0);

  // Final luminance = colour * scatter intensity.
  // With additive blending, this RGB is added directly to the framebuffer.
  vec3 luminance = avgColor * scatter;

  // For rays that hit the ground, fade based on grazing angle so we
  // don't wash out the surface (which has its own limb haze).
  if (hitsGround) {
    vec3 hitPos = rayOrigin + rayDir * innerHit.x;
    vec3 hitNormal = normalize(hitPos);
    float viewDot = abs(dot(hitNormal, rayDir));
    // pow 3.0: gentle enough to still show atmosphere near the limb,
    // aggressive enough to vanish over the surface centre.
    float limbFade = pow(1.0 - viewDot, 3.0);
    luminance *= limbFade;
  }

  // Alpha is meaningless for additive blending but set to scatter
  // so that if blending mode ever changes things still work.
  gl_FragColor = vec4(luminance, scatter);
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function makePixel(r: number, g: number, b: number, a = 255): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1);
  tex.needsUpdate = true;
  return tex;
}

// ─────────────────────────────────────────────────────────────────────────────
// EarthRenderer
// ─────────────────────────────────────────────────────────────────────────────
export class EarthRenderer {
  readonly object: THREE.Group;

  /** Written by Engine every frame via .copy(); update() propagates to uniforms. */
  readonly sunDirection: THREE.Vector3 = new THREE.Vector3(1, 0, 0);
  private readonly atmosphereCameraPos: THREE.Vector3 = new THREE.Vector3();

  private readonly earthMesh: THREE.Mesh;
  private readonly cloudMesh: THREE.Mesh;
  private readonly atmosphereMesh: THREE.Mesh;
  private readonly earthMat: THREE.ShaderMaterial;
  private readonly cloudMat: THREE.ShaderMaterial;
  private readonly atmosphereMat: THREE.ShaderMaterial;

  /** Owns the KTX2 transcoder + the loaded compressed textures (disposed in dispose()). */
  private readonly ktx: KtxTextureLoader;
  /** 1×1 placeholders shown until KTX2 textures arrive; tracked so dispose() frees them. */
  private readonly placeholders: THREE.DataTexture[] = [];
  private disposed = false;

  /**
   * @param texturesMayLoad Resolves when the KTX2 downloads may start. The globe is built and
   *   drawn straight away with 1×1 placeholder maps (plain blue sphere); the real textures
   *   are fetched and swapped in only after this resolves. Defaults to "now". Callers pass a
   *   gate so the textures don't share bandwidth with the satellite catalog on first load.
   */
  constructor(
    maxAnisotropy: number,
    renderer: THREE.WebGLRenderer,
    camera: THREE.Camera,
    texturesMayLoad: Promise<void> = Promise.resolve(),
  ) {
    this.object = new THREE.Group();

    this.ktx = new KtxTextureLoader(renderer, maxAnisotropy);

    // 1×1 placeholder shown until the corresponding KTX2 texture finishes transcoding.
    // Tracked in `placeholders` so dispose() can free them (Material.dispose() won't).
    const px = (r: number, g: number, b: number, a = 255): THREE.DataTexture => {
      const t = makePixel(r, g, b, a);
      this.placeholders.push(t);
      return t;
    };

    const initCamPos = camera.position.clone();
    this.atmosphereCameraPos.copy(initCamPos);

    // ── Earth surface ───────────────────────────────────────────────────────
    this.earthMat = new THREE.ShaderMaterial({
      uniforms: {
        uDayMap: { value: px(80, 120, 180) },
        uNightMap: { value: px(0, 0, 0) },
        uNormalMap: { value: px(128, 128, 255) },
        uSpecularMap: { value: px(0, 0, 0) },
        uSunDirection: { value: this.sunDirection.clone() },
        uCameraPos: { value: initCamPos.clone() },
      },
      vertexShader: EARTH_VERT,
      fragmentShader: EARTH_FRAG,
    });

    const earthGeo = new THREE.SphereGeometry(1.0, 128, 64);
    this.earthMesh = new THREE.Mesh(earthGeo, this.earthMat);
    this.object.add(this.earthMesh);

    // ── Cloud layer ─────────────────────────────────────────────────────────
    this.cloudMat = new THREE.ShaderMaterial({
      uniforms: {
        uCloudMap: { value: px(255, 255, 255, 0) },
        uSunDirection: { value: this.sunDirection.clone() },
      },
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      transparent: true,
      depthWrite: false,
    });

    const cloudGeo = new THREE.SphereGeometry(1.004, 64, 32);
    this.cloudMesh = new THREE.Mesh(cloudGeo, this.cloudMat);
    this.object.add(this.cloudMesh);

    // ── Atmosphere — single raymarched shell ────────────────────────────────
    // Oversized sphere ensures the camera is always outside or the front faces
    // always cover the planet silhouette. The fragment shader does all the
    // real geometry via ray-sphere intersections against uInnerRadius/uOuterRadius.
    const ATM_GEOM_RADIUS = 1.25; // larger than uOuterRadius so it frames the planet
    this.atmosphereMat = new THREE.ShaderMaterial({
      uniforms: {
        uSunDirection: { value: this.sunDirection },
        uCameraPos: { value: this.atmosphereCameraPos },
        uInnerRadius: { value: ATM_INNER_RADIUS },
        uOuterRadius: { value: ATM_OUTER_RADIUS },
        uStrength: { value: 3.2 },
      },
      vertexShader: ATM_VERT,
      fragmentShader: ATM_FRAG,
      side: THREE.BackSide,  // camera is outside — back faces cover the planet disk
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });

    const atmGeo = new THREE.SphereGeometry(ATM_GEOM_RADIUS, 64, 32);
    this.atmosphereMesh = new THREE.Mesh(atmGeo, this.atmosphereMat);
    this.object.add(this.atmosphereMesh);

    // The globe is fully built with placeholder maps. Fetch the real textures once allowed.
    texturesMayLoad
      .then(() => this.loadTextures())
      .catch((err) => console.error('[EarthRenderer] could not start texture loads', err));
  }

  /**
   * Queue every Earth texture download. Runs once, after the constructor's gate resolves
   * (skipped if the renderer was disposed while waiting). Each map replaces its 1×1
   * placeholder when it arrives; a failed load keeps the placeholder.
   */
  private loadTextures(): void {
    if (this.disposed) return;
    const load = this.ktx.load.bind(this.ktx);

    load(TEXTURE_URLS['earth-diffuse-8k'], THREE.SRGBColorSpace,
      (t) => { this.earthMat.uniforms.uDayMap.value = t; });
    load(TEXTURE_URLS['earth-night-4k'], THREE.SRGBColorSpace,
      (t) => { this.earthMat.uniforms.uNightMap.value = t; });
    load(TEXTURE_URLS['earth-bump-4k'], THREE.LinearSRGBColorSpace,
      (t) => { this.earthMat.uniforms.uNormalMap.value = t; });
    load(TEXTURE_URLS['earth-specular-4k'], THREE.LinearSRGBColorSpace,
      (t) => { this.earthMat.uniforms.uSpecularMap.value = t; });
    load(TEXTURE_URLS['earth-clouds-4k'], THREE.LinearSRGBColorSpace,
      (t) => { this.cloudMat.uniforms.uCloudMap.value = t; });

    // All Earth textures are queued — tear down the transcoder worker pool once they
    // finish (one-shot load; the textures stay valid). Frees worker threads + Basis WASM.
    this.ktx.releaseWorkersWhenIdle();
  }

  /**
   * Show/hide the from‑space surface meshes (globe + clouds + atmosphere shell)
   * WITHOUT hiding {@link object} — the group stays visible and keeps rotating so
   * layers parented to it (HorizonLayer compass, ObserverMarkerLayer) are unaffected.
   * Used by {@link EarthLayer} to drop the from‑space backdrop in dome mode, where
   * the camera sits inside the shell and it would render as artifacts.
   */
  setSurfaceVisible(visible: boolean): void {
    this.earthMesh.visible = visible;
    this.cloudMesh.visible = visible;
    this.atmosphereMesh.visible = visible;
  }

  /**
   * Called every frame.
   * Pushes uCameraPos to all shaders that need it, and propagates the
   * sunDirection (already written by Engine) to all shader uniforms.
   * Also slowly rotates the cloud mesh.
   */
  update(delta: number, camera: THREE.Camera): void {
    const camPos = camera.position;

    this.earthMat.uniforms.uSunDirection.value.copy(this.sunDirection);
    this.earthMat.uniforms.uCameraPos.value.copy(camPos);

    this.cloudMat.uniforms.uSunDirection.value.copy(this.sunDirection);

    this.atmosphereCameraPos.copy(camPos);

    this.cloudMesh.rotation.y += 0.0001 * delta;
  }

  dispose(): void {
    this.disposed = true;
    this.object.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
    });
    // Material.dispose() does not free textures held in uniforms — do it explicitly.
    this.ktx.dispose();                          // loaded CompressedTextures + transcoder pool
    for (const t of this.placeholders) t.dispose(); // 1×1 placeholders
    this.placeholders.length = 0;
  }
}