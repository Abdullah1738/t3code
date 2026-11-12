/**
 * The Needs-you page's server calls. The calls themselves live in the shared
 * runtime (the phone uses the same ones); this file says how the web reaches
 * its server: the session cookie or the connection's bearer token over HTTP,
 * and the one socket call that carries a secret.
 */
import {
  AskApiError,
  createAskApi,
  type AskSecretSendResult,
} from "@t3tools/client-runtime/ardud/kanban";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { appAtomRegistry } from "../../../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../../../state/primaryEnvironment";
import { serverEnvironment } from "../../../state/server";
import { readPreparedConnection } from "../../../state/session";

export {
  AskApiError,
  askFailureText,
  type AskAnswered,
  type AskBatchItem,
  type AskBatchResult,
  type AskDetail,
  type AskEvaluatorStart,
  type AskHandBatchResult,
  type AskHanded,
  type AskSecretOutcome,
} from "@t3tools/client-runtime/ardud/kanban";

export const askApi = createAskApi({
  target: () => {
    const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
    const connection = environmentId === null ? null : readPreparedConnection(environmentId);
    if (connection === null) throw new AskApiError(0, "offline", "Not connected to Robob.");
    const authorization = connection.httpAuthorization;
    if (authorization === null) return { base: connection.httpBaseUrl, headers: {}, cookies: true };
    if (authorization._tag === "Bearer") {
      return {
        base: connection.httpBaseUrl,
        headers: { authorization: `Bearer ${authorization.token}` },
        cookies: false,
      };
    }
    throw new AskApiError(0, "unsupported", "This connection can't reach the ask routes.");
  },
  answerSecrets: async (input): Promise<AskSecretSendResult> => {
    const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
    if (environmentId === null) return { _tag: "offline" };
    const result = await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.answerAskSecrets,
      { environmentId, input },
      // The failure cause holds the request; keep it out of the console and reports.
      { label: "answer ask secrets", reportFailure: false, reportDefect: false },
    );
    if (result._tag === "Success") return { _tag: "sent" };
    if (isAtomCommandInterrupted(result)) return { _tag: "interrupted" };
    return { _tag: "failed", failure: squashAtomCommandFailure(result) };
  },
});
