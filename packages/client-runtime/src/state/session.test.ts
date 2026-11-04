import { describe, expect, it } from "vite-plus/test";

import { RemoteEnvironmentAuthFetchError, RemoteEnvironmentAuthTimeoutError } from "../rpc/http.ts";
import { isTransientSessionStateError } from "./session.ts";

describe("session state retry", () => {
  it("retries a session read that timed out on a busy server", () => {
    expect(
      isTransientSessionStateError(
        new RemoteEnvironmentAuthTimeoutError("http://127.0.0.1:3773/api/auth/session", 6_000),
      ),
    ).toBe(true);
  });

  it("retries a transport failure", () => {
    expect(
      isTransientSessionStateError(
        new RemoteEnvironmentAuthFetchError({
          message: "Failed to fetch",
          cause: new TypeError("Failed to fetch"),
        }),
      ),
    ).toBe(true);
  });

  it("does not retry a rejected renewal or a credential answer", () => {
    expect(
      isTransientSessionStateError(
        new RemoteEnvironmentAuthFetchError({
          message: "The environment rejected the renewed session authorization.",
          cause: { authenticated: false },
        }),
      ),
    ).toBe(false);
    expect(isTransientSessionStateError({ _tag: "EnvironmentAuthInvalidError" })).toBe(false);
    expect(isTransientSessionStateError({ _tag: "EnvironmentScopeRequiredError" })).toBe(false);
  });
});
