export class BoundedTimeout extends Error {
  readonly name = "BoundedTimeout";
  constructor(readonly boundMs: number) { super("Router request timed out"); }
}

// The underlying operation can finish after this wait; timeout never proves absence.
export async function bounded<T>(operation: Promise<T>, timeout = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BoundedTimeout(timeout)), timeout);
    })]);
  } finally { clearTimeout(timer); }
}
