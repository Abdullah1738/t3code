"""Keep --env values out of offbox.log (31 Oct, Crpko #1057: a LocalStack Pro token was logged four times)."""

from __future__ import annotations

import re

from .common import say

# argparse takes any unique prefix of --env on `run`, so --e and --en are --env too.
ENV_OPTS = ("--e", "--en", "--env")
SECRETISH = re.compile(r"TOKEN|SECRET|PASSW|API_?KEY|ACCESS_KEY|PRIVATE|CREDENTIAL|AUTH", re.I)


def _spec(spec: str) -> str:
    name, eq, _ = spec.partition("=")
    return f"{name}=<redacted>" if eq else spec


def redact_argv(argv: list[str]) -> list[str]:
    """argv for the log line: every --env NAME=VALUE keeps only its name. The by-name form is unchanged."""
    out, value_next = [], False
    for x in argv:
        opt, eq, spec = x.partition("=")
        if value_next:
            out.append(_spec(x))
            value_next = False
        elif x in ENV_OPTS:
            out.append(x)
            value_next = True
        elif eq and opt in ENV_OPTS:
            out.append(f"{opt}={_spec(spec)}")
        else:
            out.append(x)
    return out


def warn_env_values(specs: list[str]) -> None:
    """A secret passed as NAME=VALUE sits on offbox's argv (ps, transcripts): steer callers to the by-name form."""
    seen = set()
    for spec in specs:
        name, eq, _ = spec.partition("=")
        if eq and name not in seen and SECRETISH.search(name):
            seen.add(name)
            say(f"--env {name}=...: the value is on offbox's command line, where ps and transcripts see it. "
                f"For secrets use the by-name form: export {name}=...; offbox run --env {name} ...")
