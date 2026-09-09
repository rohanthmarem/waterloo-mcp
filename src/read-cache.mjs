// Short-lived, bounded cache for expensive reads. Never cache errors or writes.
export class ReadCache {
  constructor({
    ttl = 30000,
    maxEntries = 32,
    maxBytes = 2 * 1024 * 1024,
    concurrency = 4,
  } = {}) {
    Object.assign(this, { ttl, maxEntries, maxBytes, concurrency });
    this.entries = new Map();
    this.pending = new Map();
    this.active = 0;
  }
  async get(key, run) {
    const hit = this.entries.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    if (hit) this.entries.delete(key);
    if (this.pending.has(key)) return this.pending.get(key);
    if (this.active >= this.concurrency) throw new Error("SERVICE_BUSY");
    this.active++;
    const promise = Promise.resolve()
      .then(run)
      .then((value) => {
        if (
          !value.isError &&
          Buffer.byteLength(JSON.stringify(value)) <= this.maxBytes
        ) {
          if (this.entries.size >= this.maxEntries)
            this.entries.delete(this.entries.keys().next().value);
          this.entries.set(key, { expires: Date.now() + this.ttl, value });
        }
        return value;
      })
      .finally(() => {
        this.active--;
        this.pending.delete(key);
      });
    this.pending.set(key, promise);
    return promise;
  }
}
