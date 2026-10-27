import { Command } from "effect/cli";

import { componentTokenCommand } from "../auth/componentTokenCommand.ts";
import { openCodeImportCommand } from "../opencode-import/command.ts";

export const ardudCommand = Command.make("ardud").pipe(
  Command.withDescription("Fork-only maintenance commands."),
  Command.withSubcommands([openCodeImportCommand, componentTokenCommand]),
);
