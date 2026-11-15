// Cold `bun run src/cli.ts` and fixture transpilation can exceed the 5 s default under parallel offbox load.
export const SUBPROCESS_TEST_TIMEOUT_MS = 30_000;
