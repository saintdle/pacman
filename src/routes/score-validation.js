const MAX_POINTS_PER_LEVEL = 104 * 10 + 4 * 50 + 4 * 4 * 100;

function parseSafeInteger(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseScoreSubmission(score, level, maxLevel) {
  const parsedScore = parseSafeInteger(score);
  if (parsedScore === null || parsedScore < 0) {
    return { error: 'score must be a non-negative safe integer' };
  }

  const parsedLevel = parseSafeInteger(level);
  if (
    parsedLevel === null
    || parsedLevel < 1
    || (maxLevel !== 'unlimited' && parsedLevel > maxLevel)
  ) {
    return { error: 'invalid level' };
  }

  if (parsedScore / parsedLevel > MAX_POINTS_PER_LEVEL) {
    return { error: 'score is implausible for level' };
  }

  return { score: parsedScore, level: parsedLevel, error: null };
}

export function validateScore(score, level, maxLevel) {
  return parseScoreSubmission(score, level, maxLevel).error;
}
