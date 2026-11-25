// Cross-tab exclusive lock per drive root (Web Locks). Without Web Locks, mutations are refused.
export class LockUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockUnavailable";
  }
}

type LockManagerLike = {
  request: (
    name: string,
    opts: { mode: "exclusive"; ifAvailable: true },
    cb: (lock: unknown) => Promise<unknown>,
  ) => Promise<unknown>;
};

export async function withRootLock<T>(
  rootId: string,
  fn: () => Promise<T>,
  locks?: LockManagerLike,
): Promise<T> {
  const lm =
    locks ??
    (typeof navigator !== "undefined"
      ? (navigator as unknown as { locks?: LockManagerLike }).locks
      : undefined);
  if (!lm)
    throw new LockUnavailable(
      "This browser can't coordinate DriveTidy windows, so file changes are disabled.",
    );
  let result: T | undefined;
  let granted = false;
  await lm.request(
    `drivetidy:${rootId}`,
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      if (!lock) return;
      granted = true;
      result = await fn();
    },
  );
  if (!granted) throw new LockUnavailable("Another DriveTidy window is changing this drive.");
  return result as T;
}
