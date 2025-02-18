import { DropboxResponseError, type DropboxResponse } from "dropbox";
import Timeout = NodeJS.Timeout;

type Thunk<T> = () => Promise<DropboxResponse<T>>;

export default class Limiter {
  #queue: (() => void)[] = [];
  #timer?: Timer;
  #inflight: number = 0;

  #wait: number = 0.1;
  #lastIncrease?: bigint;

  #complete?: Promise<void>;
  #completeResolve?: () => void;

  constructor() {
    this.#notifyComplete(); // setup completion notification
  }

  #setWait(wait: number) {
    const min = 0.1;
    const max = 1000;
    const increaseMinNanos = BigInt(10_000_000);

    const newWait = Math.min(Math.max(wait, min), max);
    if (newWait != this.#wait) {
      if (newWait > this.#wait) {
        // Don't scale up too quickly, we could have hundreds of tasks in-flight
        const t = process.hrtime.bigint();
        if (this.#lastIncrease && (t - this.#lastIncrease) < increaseMinNanos) {
          return;
        }
        this.#lastIncrease = t;
      }

      this.#wait = newWait;
    };
  }

  #loop() {
    const f = this.#queue.shift();
    if (f) {
      this.#inflight++;
      f();

      if (this.#wait >= 1) {
        this.#timer = setTimeout(() => this.#loop(), this.#wait);
      } else {
        this.#timer = setImmediate(() => this.#loop());
      }
    } else {
      // Pause looping
      this.#timer = undefined;
    }
  }

  #startTimer() {
    if (!this.#timer) {
      this.#timer = setTimeout(() => this.#loop(), 0);
    }
  }

  async run<T>(f: Thunk<T>): Promise<T> {
    return this.#doRun(f, x => this.#queue.push(x));
  }

  async runHi<T>(f: Thunk<T>): Promise<T> {
    return this.#doRun(f, x => this.#queue.unshift(x));
  }

  #notifyComplete() {
    if (this.#completeResolve) {
      this.#completeResolve!();
    }
    // Ensure future waits don't immediately resolve
    this.#complete = new Promise<void>((resolve) => {
      this.#completeResolve = resolve;
    });
  }

  async #doRun<T>(f: Thunk<T>, addFn: (_: any) => void): Promise<T> {
    const p = new Promise<T>((resolve, reject) => {
      const doRun = async () => {
        try {
          const res = await f();

          // Success!
          this.#inflight--;
          this.#setWait(this.#wait / 1.2);
          resolve(res.result);

          // Maybe we're totally done?
          if (this.#queue.length === 0 && this.#inflight === 0) {
            this.#notifyComplete();
          }

        } catch (e) {
          this.#inflight--;

          if (e instanceof DropboxResponseError && e.status === 429) {
            // Rate limited: retry soon, but backoff
            this.#setWait(this.#wait * 2);
            this.#queue.unshift(doRun); // return to queue, at highest priority
            this.#startTimer(); // timer may have been stopped if queue emptied
            return;
          }
          reject(e);
        }
      };
      addFn(doRun);
    });
    this.#startTimer();
    return p;
  }

  wait(): Promise<void> {
    return this.#complete!;
  }
}