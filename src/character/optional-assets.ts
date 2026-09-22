// Validate untrusted optional data before it reaches SDK parsers or the frame loop.
type RecordValue = Record<string, any>;
export type Expression = { Id: string; Value: number; Blend: 'Add' | 'Multiply' | 'Overwrite' }[];
const object = (value: unknown): value is RecordValue =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512;
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function array(value: unknown, name: string, maximum = 4096): any[] {
  requireValue(Array.isArray(value) && value.length <= maximum, `${name} 배열이 손상되었습니다.`);
  return value;
}
function pair(value: unknown) {
  requireValue(object(value) && finite(value.X) && finite(value.Y), '물리 좌표가 손상되었습니다.');
}
export function parseExpression(value: unknown, parameterIds: Set<string>): Expression {
  requireValue(object(value), '표정 객체가 필요합니다.');
  return array(value.Parameters, 'Parameters').map((parameter) => {
    requireValue(
      object(parameter) && id(parameter.Id) && parameterIds.has(parameter.Id),
      '표정이 실제 모델 파라미터를 참조하지 않습니다.',
    );
    requireValue(finite(parameter.Value), '표정 값은 유한한 숫자여야 합니다.');
    const blend = parameter.Blend ?? 'Add';
    requireValue(
      ['Add', 'Multiply', 'Overwrite'].includes(blend),
      '지원하지 않는 표정 Blend입니다.',
    );
    return { Id: parameter.Id, Value: parameter.Value, Blend: blend };
  });
}
export function validatePose(value: unknown, partIds: Set<string>) {
  requireValue(object(value), '포즈 객체가 필요합니다.');
  requireValue(
    value.FadeInTime === undefined || (finite(value.FadeInTime) && value.FadeInTime >= 0),
    '포즈 전환 시간이 잘못되었습니다.',
  );
  for (const group of array(value.Groups, 'Groups')) {
    const parts = array(group, '포즈 그룹');
    requireValue(parts.length > 0, '빈 포즈 그룹입니다.');
    for (const part of parts) {
      requireValue(
        object(part) && id(part.Id) && partIds.has(part.Id),
        '모델에 없는 포즈 파츠입니다.',
      );
      for (const link of array(part.Link ?? [], 'Link'))
        requireValue(id(link) && partIds.has(link), '모델에 없는 연결 파츠입니다.');
    }
  }
}
export function validatePhysics(value: unknown, parameterIds: Set<string>) {
  requireValue(
    object(value) && value.Version === 3 && object(value.Meta),
    '물리 Version 3/Meta가 필요합니다.',
  );
  const settings = array(value.PhysicsSettings, 'PhysicsSettings');
  requireValue(settings.length > 0, '물리 설정이 비어 있습니다.');
  const meta = value.Meta;
  requireValue(object(meta.EffectiveForces), '물리 외력 설정이 없습니다.');
  pair(meta.EffectiveForces.Gravity);
  pair(meta.EffectiveForces.Wind);
  requireValue(
    meta.Fps === undefined || (finite(meta.Fps) && meta.Fps >= 0 && meta.Fps <= 240),
    '물리 FPS 범위가 잘못되었습니다.',
  );
  let inputs = 0,
    outputs = 0,
    vertices = 0;
  for (const setting of settings) {
    requireValue(object(setting) && object(setting.Normalization), '물리 정규화 설정이 없습니다.');
    for (const key of ['Position', 'Angle']) {
      const range = setting.Normalization[key];
      requireValue(
        object(range) &&
          finite(range.Minimum) &&
          finite(range.Maximum) &&
          finite(range.Default) &&
          range.Minimum < range.Maximum &&
          range.Default >= range.Minimum &&
          range.Default <= range.Maximum,
        '물리 정규화 범위가 잘못되었습니다.',
      );
    }
    const points = array(setting.Vertices, 'Vertices');
    requireValue(points.length > 0, '물리 정점이 없습니다.');
    vertices += points.length;
    for (const point of points) {
      requireValue(object(point), '물리 정점이 손상되었습니다.');
      pair(point.Position);
      for (const key of ['Mobility', 'Delay', 'Acceleration', 'Radius'])
        requireValue(finite(point[key]) && point[key] >= 0, '물리 정점 값이 잘못되었습니다.');
    }
    for (const [kind, target] of [
      ['Input', 'Source'],
      ['Output', 'Destination'],
    ]) {
      const bindings = array(setting[kind], kind);
      if (kind === 'Input') inputs += bindings.length;
      else outputs += bindings.length;
      for (const binding of bindings) {
        requireValue(
          object(binding) &&
            object(binding[target]) &&
            binding[target].Target === 'Parameter' &&
            parameterIds.has(binding[target].Id),
          '물리 연결이 실제 파라미터를 참조하지 않습니다.',
        );
        requireValue(
          ['X', 'Y', 'Angle'].includes(binding.Type) &&
            typeof binding.Reflect === 'boolean' &&
            finite(binding.Weight) &&
            binding.Weight >= 0 &&
            binding.Weight <= 100,
          '물리 연결 형식/가중치가 잘못되었습니다.',
        );
        if (kind === 'Output')
          requireValue(
            Number.isInteger(binding.VertexIndex) &&
              binding.VertexIndex >= 1 &&
              binding.VertexIndex < points.length &&
              finite(binding.Scale),
            '물리 출력 정점/배율이 잘못되었습니다.',
          );
      }
    }
  }
  for (const [key, count] of [
    ['PhysicsSettingCount', settings.length],
    ['TotalInputCount', inputs],
    ['TotalOutputCount', outputs],
    ['VertexCount', vertices],
  ] as const) {
    requireValue(meta[key] === count && count <= 65_536, `물리 ${key}가 실제 데이터와 다릅니다.`);
  }
  requireValue(outputs > 0, '모델에 적용할 물리 출력이 없습니다.');
}
