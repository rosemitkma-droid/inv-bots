/**
 * Wall-clock time-block boundary emitter.
 *
 * Blocks are aligned to UTC midnight (matching TimeBlocks.mq5's DayStart()
 * behaviour — the server-time midnight anchors the grid). For a blockMinutes
 * of 3, boundaries land at 00:00, 00:03, 00:06, …  So "the current 3-min block"
 * at 14:27:45 UTC is [14:27:00, 14:30:00).
 *
 * Emits two events:
 *   - 'block-start'  right after a new block begins (passes { start, end })
 *   - 'block-end'    right after the previous block ends (passes { start, end })
 *
 * Ordering: on every boundary crossing, 'block-end' for the just-closed block
 * fires BEFORE 'block-start' for the new one, so callers can realise the old
 * pair's P/L before opening the new pair.
 */

export interface BlockWindow {
  start: number; // epoch seconds
  end: number;   // epoch seconds, exclusive
}

type Handler = (w: BlockWindow) => void;

export class BlockClock {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onStart = new Set<Handler>();
  private onEnd = new Set<Handler>();
  private current: BlockWindow;
  private stopped = true;

  constructor(private blockSec: number) {
    if (!Number.isFinite(blockSec) || blockSec <= 0) {
      throw new Error(`BlockClock: blockSec must be > 0 (got ${blockSec})`);
    }
    this.current = BlockClock.windowAt(Date.now() / 1000, blockSec);
  }

  static windowAt(nowSec: number, blockSec: number): BlockWindow {
    // Snap to UTC midnight grid: epoch 0 is already UTC midnight, so a naive
    // floor-to-multiple suffices as long as blockSec divides 86400.
    const start = Math.floor(nowSec / blockSec) * blockSec;
    return { start, end: start + blockSec };
  }

  currentWindow(): BlockWindow {
    return { ...this.current };
  }

  secondsUntilEnd(nowSec = Date.now() / 1000): number {
    return Math.max(0, this.current.end - nowSec);
  }

  on(event: 'block-start' | 'block-end', h: Handler): () => void {
    const set = event === 'block-start' ? this.onStart : this.onEnd;
    set.add(h);
    return () => set.delete(h);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // Do NOT emit a retroactive 'block-start' for the already-in-progress block.
    // Callers can query currentWindow() if they want to warm up immediately;
    // open trades only fire at real boundary transitions.
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    const nowMs = Date.now();
    const endMs = this.current.end * 1000;
    // Fire slightly AFTER the boundary to make sure Deriv's clock has also
    // ticked past it (otherwise a proposal duration=end-now can round to 0).
    const delay = Math.max(50, endMs - nowMs + 50);
    this.timer = setTimeout(() => this.tick(), delay);
  }

  private tick(): void {
    if (this.stopped) return;
    const closed = this.current;
    const next = BlockClock.windowAt(Date.now() / 1000, this.blockSec);
    this.current = next;

    for (const h of this.onEnd) h(closed);
    for (const h of this.onStart) h(next);

    this.schedule();
  }
}
