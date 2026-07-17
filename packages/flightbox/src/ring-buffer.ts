/**
 * Fixed-size ring buffer over ONE preallocated Buffer — GC-invisible by
 * design. Records are length-prefixed variable-size byte blobs:
 *
 *   [u32 LE length][payload bytes]
 *
 * Wrap boundary (ADR 011, strict no-split): a record that doesn't fit in the
 * tail is written ENTIRELY at offset 0 — records never straddle the boundary
 * (this invariant is what makes raw panic dumps parseable, ADR 009). If >= 4
 * bytes remain at the tail, an explicit WRAP marker (u32 0xFFFFFFFF) is
 * written; a tail gap smaller than 4 bytes is an implicit wrap. Worst-case
 * tail waste is one max-record (~2.1KB truncated) per lap — ~0.003% of a
 * 64MB ring. Writes evict the oldest records they would overwrite.
 * snapshot() copies records out oldest-first.
 */

const LEN_BYTES = 4;
const WRAP_MARKER = 0xffffffff;

export class RingBuffer {
  readonly capacity: number;
  private readonly buf: Buffer;
  private writePos = 0;
  /** Offset of the oldest valid record. Meaningless when count === 0. */
  private oldest = 0;
  private count = 0;
  private droppedCount = 0;

  constructor(capacityBytes: number) {
    if (!Number.isInteger(capacityBytes) || capacityBytes < 16) {
      throw new RangeError(`ring buffer capacity must be an integer >= 16 bytes, got ${capacityBytes}`);
    }
    this.capacity = capacityBytes;
    this.buf = Buffer.allocUnsafe(capacityBytes);
  }

  /** Number of records currently held. */
  get size(): number {
    return this.count;
  }

  /** Records rejected because they exceed total capacity. */
  get dropped(): number {
    return this.droppedCount;
  }

  /**
   * Appends one record. The optional second part lets the hot path write
   * header + body as one frame without concatenating them first (ADR 015).
   */
  write(payload: Buffer | Uint8Array, payload2?: Buffer | Uint8Array): boolean {
    const recordLen = payload.length + (payload2 !== undefined ? payload2.length : 0);
    const needed = LEN_BYTES + recordLen;
    if (needed > this.capacity) {
      this.droppedCount++;
      return false;
    }

    if (this.writePos + needed > this.capacity) {
      // Reclaim whatever lives in the tail, mark it skipped, wrap to 0.
      this.evictRange(this.writePos, this.capacity);
      if (this.capacity - this.writePos >= LEN_BYTES) {
        this.buf.writeUInt32LE(WRAP_MARKER, this.writePos);
      }
      this.writePos = 0;
    }

    this.evictRange(this.writePos, this.writePos + needed);
    if (this.count === 0) this.oldest = this.writePos;

    this.buf.writeUInt32LE(recordLen, this.writePos);
    this.buf.set(payload, this.writePos + LEN_BYTES);
    if (payload2 !== undefined) {
      this.buf.set(payload2, this.writePos + LEN_BYTES + payload.length);
    }
    this.writePos += needed;
    this.count++;
    return true;
  }

  /**
   * Copies all records out in chronological order. Recording can continue
   * afterwards; the returned buffers are independent copies.
   */
  snapshot(): Buffer[] {
    return RingBuffer.readRecords(this.buf, this.capacity, this.oldest, this.count);
  }

  /**
   * ADR 009 panic path ONLY: the live underlying buffer and pointers, for a
   * raw zero-allocation dump. Everything else must go through snapshot().
   */
  get rawState(): { buf: Buffer; oldest: number; count: number } {
    return { buf: this.buf, oldest: this.oldest, count: this.count };
  }

  /**
   * Frame-walks a ring image. Shared by live snapshots and panic-file
   * recovery — the latter reads bytes from a crashed process, so lengths are
   * bounds-checked and the walk bails on the first corrupt frame.
   */
  static readRecords(buf: Buffer, capacity: number, oldest: number, count: number): Buffer[] {
    const out: Buffer[] = [];
    let pos = oldest;
    for (let i = 0; i < count; i++) {
      if (pos < 0 || pos > capacity) break;
      if (capacity - pos < LEN_BYTES || buf.readUInt32LE(pos) === WRAP_MARKER) pos = 0;
      const len = buf.readUInt32LE(pos);
      if (len > capacity - pos - LEN_BYTES) break;
      out.push(Buffer.from(buf.subarray(pos + LEN_BYTES, pos + LEN_BYTES + len)));
      pos += LEN_BYTES + len;
    }
    return out;
  }

  clear(): void {
    this.writePos = 0;
    this.oldest = 0;
    this.count = 0;
  }

  /** Skip implicit (tail gap < 4B) and explicit wrap markers. */
  private normalize(pos: number): number {
    if (this.capacity - pos < LEN_BYTES || this.buf.readUInt32LE(pos) === WRAP_MARKER) {
      return 0;
    }
    return pos;
  }

  /** Evict oldest records while they start inside [start, end). */
  private evictRange(start: number, end: number): void {
    while (this.count > 0) {
      this.oldest = this.normalize(this.oldest);
      if (this.oldest < start || this.oldest >= end) return;
      const len = this.buf.readUInt32LE(this.oldest);
      this.oldest += LEN_BYTES + len;
      this.count--;
    }
  }
}
