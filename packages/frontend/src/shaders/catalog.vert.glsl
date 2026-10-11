attribute vec3 previousPosition;
attribute vec3 currentPosition;
attribute vec3 color;
attribute float previousSize;
attribute float currentSize;
attribute vec3 pickId;
attribute float highlight; // 1.0 = naked-eye-visible in Sky Dome → gold tint

uniform float uPixelRatio;
uniform float uCameraDistance;
uniform vec3 uBaseColor;
uniform float uT;
uniform float uSelectedIndex;    // -1.0 = no selection
uniform float uCandidateIndex;   // -1.0 = none; gamepad reticle soft-lock highlight
uniform float uTimeSinceArrival; // seconds since camera arrived; -1.0 = no pulse

varying vec3 vColor;
varying vec3 vPickId;
varying float vDistanceFade;

void main() {
  float lerpedSize = mix(previousSize, currentSize, uT);
  if (lerpedSize < 0.01) {
    gl_Position = vec4(0.0, 0.0, -999.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }

  vec3 lerpedPos = mix(previousPosition, currentPosition, uT);
  vec4 viewPos = modelViewMatrix * vec4(lerpedPos, 1.0);
  gl_Position = projectionMatrix * viewPos;

  float dist = length(viewPos.xyz);
  // Respond to zoom sublinearly, then fade each point by its own camera distance.
  float cameraScale = pow(max(uCameraDistance, 1.0), 0.55);
  float distAttenuation = pow(max(dist, 0.0001), 0.72);
  float pointSize = (2.9 * uPixelRatio * lerpedSize * cameraScale) / distAttenuation;
  float logDist = log2(dist + 1.0);
  float sizeFade = 1.0 - smoothstep(log2(5.0), log2(140.0), logDist);
  float alphaFade = 1.0 - smoothstep(log2(6.0), log2(180.0), logDist);

  // gl_VertexID is available in WebGL 2 / GLSL ES 3.00 (Three.js r165+)
  bool isSelected = uSelectedIndex >= 0.0 && abs(float(gl_VertexID) - uSelectedIndex) < 0.5;
  bool isCandidate = !isSelected && uCandidateIndex >= 0.0 && abs(float(gl_VertexID) - uCandidateIndex) < 0.5;

  if (isSelected) {
    float sizeBoost = 2.5;

    // Triple pulse: 3 cycles over 1.5 seconds (2 Hz → ω = 4π ≈ 12.566)
    if (uTimeSinceArrival >= 0.0 && uTimeSinceArrival < 1.5) {
      float pulse = sin(uTimeSinceArrival * 12.566);
      sizeBoost = 2.5 + 1.5 * pulse; // oscillates [1.0, 4.0]
    }

    sizeFade = max(sizeFade, 0.45);
    alphaFade = max(alphaFade, 0.6);
    pointSize *= max(sizeBoost, 1.0);
    vColor = vec3(0.0, 0.898, 1.0); // cyan override for selected object
  } else if (isCandidate) {
    // Reticle candidate: amber, bigger, no pulse (the pulse means "just arrived").
    sizeFade = max(sizeFade, 0.45);
    alphaFade = max(alphaFade, 0.6);
    pointSize *= 1.8;
    vColor = vec3(1.0, 0.55, 0.1);
  } else {
    // Sky-dome naked-eye highlight: tint toward bright gold so the visible passes
    // pop out of the faint background traffic regardless of category colour.
    vColor = mix(color * uBaseColor, vec3(1.0, 0.92, 0.55), highlight);
  }

  pointSize *= pow(max(sizeFade, 0.0), 0.82);
  if (pointSize < 0.16 || alphaFade < 0.01) {
    gl_Position = vec4(0.0, 0.0, -999.0, 1.0);
    gl_PointSize = 0.0;
    vDistanceFade = 0.0;
    vPickId = pickId;
    return;
  }

  gl_PointSize = clamp(pointSize, 0.65, 20.0);
  vDistanceFade = alphaFade;
  vPickId = pickId;
}
