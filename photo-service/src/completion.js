export const PHOTO_REQUIREMENTS = Object.freeze({
  stop: 1,
  pp: 2,
  entrance: 1,
});

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
