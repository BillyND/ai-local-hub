interface Waiter {
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  onAbort: () => void;
}

class Slots {
  private active = 0;
  private readonly queue = new Set<Waiter>();

  constructor(
    private readonly maximum: number,
    private readonly maxQueued: number,
  ) {
    if (
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      !Number.isSafeInteger(maxQueued) ||
      maxQueued < 0
    ) {
      throw new Error(
        "Tool capacity requires a positive active limit and a nonnegative queue limit.",
      );
    }
  }

  async acquire(signal: AbortSignal): Promise<(() => void) | undefined> {
    signal.throwIfAborted();
    if (this.active < this.maximum) {
      this.active += 1;
      return () => this.release();
    }
    if (this.queue.size >= this.maxQueued) return undefined;
    return await new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        onAbort: () => {
          this.queue.delete(waiter);
          reject(signal.reason);
        },
      };
      this.queue.add(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    });
  }

  private release(): void {
    const next = this.queue.values().next().value;
    if (!next) {
      this.active -= 1;
      return;
    }
    this.queue.delete(next);
    next.signal.removeEventListener("abort", next.onAbort);
    // Transfer the existing slot instead of releasing and reacquiring it.
    next.resolve(() => this.release());
  }
}

export class ToolCapacity {
  private readonly files: Slots;
  private readonly processes: Slots;

  constructor(
    maxFiles = 128,
    maxProcesses = 16,
    maxQueuedFiles = 1_024,
    maxQueuedProcesses = 64,
  ) {
    this.files = new Slots(maxFiles, maxQueuedFiles);
    this.processes = new Slots(maxProcesses, maxQueuedProcesses);
  }

  acquire(
    name: string,
    signal: AbortSignal,
  ): Promise<(() => void) | undefined> {
    const processTool =
      name === "bash" ||
      name === "powershell" ||
      name === "grep" ||
      name === "find";
    return (processTool ? this.processes : this.files).acquire(signal);
  }
}
