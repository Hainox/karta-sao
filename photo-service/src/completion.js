export const PHOTO_REQUIREMENTS = Object.freeze({
  stop: 1,
  pp: 2,
  entrance: 1,
});

/**
 * Момент, с которого переход требует два кадра (12:00 МСК 18.09.2026).
 *
 * Раньше сайт закрывал точку перехода после одного кадра, и районы снимали по
 * одному. Требование двух появилось позже самой съёмки, поэтому всё снятое до
 * этого момента засчитывается по прежнему правилу — иначе районы потеряли бы
 * уже выполненную работу из-за нашей недоработки.
 */
export const PHOTO_NORM_SINCE = '2026-09-18T09:00:00Z';

export function completionProgress(completedObjects, totalObjects) {
  if (
    !Number.isSafeInteger(completedObjects)
    || completedObjects < 0
    || !Number.isSafeInteger(totalObjects)
    || totalObjects < 0
  ) {
    throw new TypeError('Object counts must be non-negative safe integers');
  }

  if (completedObjects > totalObjects) {
    throw new RangeError('Completed objects cannot exceed the total object count');
  }

  if (totalObjects === 0) {
    return {
      completedObjects,
      totalObjects,
      completionPercent: null,
      band: null,
    };
  }

  const completed = BigInt(completedObjects);
  const total = BigInt(totalObjects);
  const band = completed * 100n < total * 33n
    ? 'low'
    : completed * 100n < total * 66n
      ? 'middle'
      : 'high';

  return {
    completedObjects,
    totalObjects,
    completionPercent: completedObjects / totalObjects * 100,
    band,
  };
}
