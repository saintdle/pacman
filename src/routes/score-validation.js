const MAX_POINTS_PER_LEVEL = 104 * 10 + 4 * 50 + 4 * 4 * 100;

export function validateScore(score, level, maxLevel) {
  if (!Number.isFinite(score)) return 'score must be a number';
  if (!Number.isFinite(level)) return null;
  if (level < 1 || (maxLevel !== 'unlimited' && level > maxLevel)) return 'invalid level';
  if (score / level > MAX_POINTS_PER_LEVEL) return 'score is implausible for level';
  return null;
}
