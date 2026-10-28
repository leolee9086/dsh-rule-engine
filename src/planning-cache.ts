/** Typed projection definitions; the Host owns storage, disposal and diagnostic counters. */
export interface PlanningCacheKey<O extends object, T> {
  readonly name: string
  readonly validity: string
  create(owner: O, dependencies: readonly unknown[]): T
}
export interface PlanningCachePort {
  define<O extends object, T>(name: string, validity: string, create: (owner: O, dependencies: readonly unknown[]) => T): PlanningCacheKey<O, T>
  use<O extends object, T>(owner: O, key: PlanningCacheKey<O, T>, dependencies?: readonly unknown[]): T
  clear(key: object): void
  worked(key: object, amount?: number): void
}
