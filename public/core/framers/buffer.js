// @ts-check
/**
 * A growable byte queue used by every framer. Chunks from a Web Serial reader arrive
 * in arbitrary sizes; the framer appends them here and cuts frames from the front.
 */
export class ByteQueue {
  /** @param {number} [capacity] */
  constructor(capacity = 256) {
    this.buf = new Uint8Array(capacity);
    this.start = 0;
    this.end = 0;
  }

  get length() {
    return this.end - this.start;
  }

  /** @param {Uint8Array} chunk */
  append(chunk) {
    if (this.end + chunk.length > this.buf.length) {
      const needed = this.length + chunk.length;
      if (needed <= this.buf.length && this.start > 0) {
        this.buf.copyWithin(0, this.start, this.end);
      } else {
        const next = new Uint8Array(Math.max(needed, this.buf.length * 2));
        next.set(this.buf.subarray(this.start, this.end));
        this.buf = next;
      }
      this.end -= this.start;
      this.start = 0;
    }
    this.buf.set(chunk, this.end);
    this.end += chunk.length;
  }

  /** @param {number} index */
  at(index) {
    return this.buf[this.start + index];
  }

  /** Copy of the first n bytes. @param {number} n */
  peek(n) {
    return this.buf.slice(this.start, this.start + n);
  }

  /** @param {number} n */
  take(n) {
    const out = this.peek(n);
    this.drop(n);
    return out;
  }

  /** @param {number} n */
  drop(n) {
    this.start += Math.min(n, this.length);
    if (this.start === this.end) this.start = this.end = 0;
  }

  /** @param {number} byte @param {number} [from] */
  indexOf(byte, from = 0) {
    for (let i = this.start + from; i < this.end; i += 1) if (this.buf[i] === byte) return i - this.start;
    return -1;
  }

  clear() {
    this.start = this.end = 0;
  }
}
