import * as THREE from 'three';

/** Pull-back length. */
export const UNFOLLOW_MS = 450;

/** What a pull-back needs to remember between frames. */
export interface UnfollowPlan {
  startTime: number;
  duration: number;
  startDist: number;
  endDist: number;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Camera distance from the target `nowMs` into a pull-back, and whether it is over. Pure. */
export function unfollowStep(plan: UnfollowPlan, nowMs: number): { distance: number; done: boolean } {
  const t = Math.min(Math.max((nowMs - plan.startTime) / plan.duration, 0), 1);
  return { distance: THREE.MathUtils.lerp(plan.startDist, plan.endDist, smoothstep(t)), done: t >= 1 };
}

/**
 * Whether leaving follow needs a pull-back, and its plan. Null when the camera
 * is already outside the orbit controls' minimum distance (hand over at once).
 */
export function planUnfollow(dist: number, minDist: number, nowMs: number): UnfollowPlan | null {
  if (dist >= minDist) return null;
  return { startTime: nowMs, duration: UNFOLLOW_MS, startDist: dist, endDist: minDist };
}

/**
 * The follow -> free pull-back. Follow and joyride sit far inside OrbitControls'
 * minDistance; handing over as-is would snap the camera out in one frame, so the
 * distance eases out along the camera's own backward axis (frozen at start) while
 * the target keeps tracking the live object.
 */
export class UnfollowAnimator {
  private plan: UnfollowPlan | null = null;
  /** Camera's backward axis at press time; fixed so the camera slides straight back. */
  private readonly backward = new THREE.Vector3();

  isActive(): boolean {
    return this.plan !== null;
  }

  /** Begin a pull-back from the camera's current pose. False when none is needed. */
  start(camera: THREE.PerspectiveCamera, target: THREE.Vector3, minDist: number, nowMs: number): boolean {
    const plan = planUnfollow(camera.position.distanceTo(target), minDist, nowMs);
    if (!plan) return false;
    this.plan = plan;
    camera.getWorldDirection(this.backward).negate();
    return true;
  }

  /** Re-seat the camera along the frozen axis from this frame's live target. True when finished. */
  apply(camera: THREE.PerspectiveCamera, target: THREE.Vector3, nowMs: number): boolean {
    if (!this.plan) return false;
    const { distance, done } = unfollowStep(this.plan, nowMs);
    camera.position.copy(target).addScaledVector(this.backward, distance);
    camera.lookAt(target);
    if (done) this.plan = null;
    return done;
  }

  cancel(): void {
    this.plan = null;
  }
}
