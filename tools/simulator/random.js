export function createRandom(seed, workerId = 1) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new RangeError('seed must be a uint32 integer');
  }
  if (!Number.isSafeInteger(workerId) || workerId < 0) {
    throw new RangeError('workerId must be a non-negative safe integer');
  }

  let state = (seed ^ Math.imul(workerId, 0x9e37_79b9)) >>> 0;
  if (state === 0) state = 0x6d2b_79f5;

  function nextUint32() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  }

  return {
    next() {
      return nextUint32() / 0x1_0000_0000;
    },
    int(min, max) {
      if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
        throw new RangeError('random integer bounds must be ordered safe integers');
      }
      return min + Math.floor(this.next() * (max - min + 1));
    },
    chance(probability) {
      if (
        typeof probability !== 'number' ||
        !Number.isFinite(probability) ||
        probability < 0 ||
        probability > 1
      ) {
        throw new RangeError('probability must be a finite number from 0 through 1');
      }
      return this.next() < probability;
    },
  };
}
