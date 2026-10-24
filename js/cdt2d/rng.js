// Seeded random numbers for the 2D CDT simulator: xoshiro128** seeded through splitmix32.
// Derived from 2d-cdt (MIT, (c) 2020 Joren Brunekreef and Andrzej Görlich) via the corrected
// CDT_4d-master port; see LICENSE in this folder. The C++ uses one std::mt19937_64 per chain
// (cdt/common/rng.hpp); this engine plays the same role (one engine drives every choice of the
// chain) but does not reproduce its stream.

function splitmix32(state) {
  return function () {
    state = (state + 0x9e3779b9) | 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
}

export class Rng {
  // seed: any integer in [0, 2^53); seeds that differ in any bit give unrelated streams
  constructor(seed = 0) {
    if (!Number.isSafeInteger(seed) || seed < 0) throw new RangeError('Rng: seed must be a non-negative safe integer');
    const lo = splitmix32(seed >>> 0);
    const hi = splitmix32(Math.floor(seed / 4294967296) ^ 0x43445432);  // "CDT2"
    this.s0 = lo() ^ hi();
    this.s1 = lo() ^ hi();
    this.s2 = lo() ^ hi();
    this.s3 = lo() ^ hi();
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;  // the all-zero state is a fixed point
  }

  // next 32-bit unsigned integer
  next() {
    const s1 = this.s1;
    const r = Math.imul(s1, 5);
    const result = Math.imul((r << 7) | (r >>> 25), 9) >>> 0;
    const t = s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = (this.s3 << 11) | (this.s3 >>> 21);
    return result;
  }

  // uniform double in [0, 1) with 53 random bits (std::uniform_real_distribution<>(0, 1))
  uniform() {
    const hi = this.next() >>> 5;  // 27 bits
    const lo = this.next() >>> 6;  // 26 bits
    return (hi * 67108864 + lo) / 9007199254740992;
  }

  // unbiased integer in [0, n), 1 <= n <= 2^32 (std::uniform_int_distribution<>(0, n - 1))
  int(n) {
    const limit = 4294967296 - (4294967296 % n);
    let x;
    do x = this.next(); while (x >= limit);
    return x % n;
  }

  getState() {
    return [this.s0, this.s1, this.s2, this.s3];
  }

  setState(s) {
    [this.s0, this.s1, this.s2, this.s3] = s;
  }
}
