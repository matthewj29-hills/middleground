// Tiny typed pub/sub store — no dependencies.
type Listener<T> = (v: T) => void;

export class Cell<T> {
  private v: T;
  private ls = new Set<Listener<T>>();
  constructor(initial: T) { this.v = initial; }
  get(): T { return this.v; }
  set(v: T): void {
    if (v === this.v) return;
    this.v = v;
    this.ls.forEach(l => l(v));
  }
  update(fn: (v: T) => T): void { this.set(fn(this.v)); }
  sub(l: Listener<T>): () => void {
    this.ls.add(l);
    l(this.v);
    return () => this.ls.delete(l);
  }
}

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
