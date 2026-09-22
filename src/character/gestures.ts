export type Gesture = 'none' | 'nod' | 'tilt' | 'smallBounce' | 'lookAway';
export type GesturePose = {
  angleX: number;
  angleY: number;
  angleZ: number;
  bodyX: number;
  bodyY: number;
  bodyZ: number;
  tracking: number;
};
const durations: Record<Gesture, number> = {
  none: 0,
  nod: 1.2,
  tilt: 1.4,
  smallBounce: 1.3,
  lookAway: 1.6,
};

export function gestureName(value: unknown): Gesture {
  return typeof value === 'string' && Object.hasOwn(durations, value) ? (value as Gesture) : 'none';
}

/** One bounded gesture, measured from its own start; values are fractions of a parameter range. */
export function sampleGesture(gesture: Gesture, age: number, strength: number): GesturePose {
  const pose = { angleX: 0, angleY: 0, angleZ: 0, bodyX: 0, bodyY: 0, bodyZ: 0, tracking: 1 };
  const duration = durations[gesture];
  if (
    !duration ||
    !Number.isFinite(age) ||
    !Number.isFinite(strength) ||
    strength <= 0 ||
    age <= 0 ||
    age >= duration
  )
    return pose;
  const phase = age / duration;
  // Zero position and velocity at both ends, including when tracking returns to full strength.
  const envelope = Math.sin(Math.PI * phase) ** 2 * Math.max(0, Math.min(1, strength));
  const pulse = Math.sin(phase * Math.PI * 4) * envelope;
  pose.tracking = 1 - 0.65 * envelope;
  switch (gesture) {
    case 'nod':
      pose.angleY = -0.16 * pulse;
      break;
    case 'tilt':
      pose.angleZ = 0.23 * envelope;
      pose.bodyZ = 0.08 * envelope;
      break;
    case 'smallBounce':
      // A brief head/upper-body rhythm, never a model translation or jump.
      pose.angleY = 0.1 * pulse;
      pose.bodyY = 0.18 * pulse;
      break;
    case 'lookAway':
      pose.angleX = -0.3 * envelope;
      pose.bodyX = -0.12 * envelope;
      break;
  }
  return pose;
}

/** Scale a signed fraction around the actual model's default, including asymmetric ranges. */
export function parameterOffset(
  parameter: { minimum: number; maximum: number; default: number } | undefined,
  fraction: number,
): number {
  if (
    !parameter ||
    !Number.isFinite(fraction) ||
    ![parameter.minimum, parameter.maximum, parameter.default].every(Number.isFinite) ||
    parameter.minimum > parameter.default ||
    parameter.default > parameter.maximum
  )
    return 0;
  const range =
    fraction < 0 ? parameter.default - parameter.minimum : parameter.maximum - parameter.default;
  return Math.max(-1, Math.min(1, fraction)) * range;
}
