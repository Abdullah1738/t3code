"""Normalization helpers shared by the consolidation pass and retrieval."""
import re

_GENERIC_SUFFIX = re.compile(
    r"(?:\s+(?:repo|repository|project|codebase|workspace|work|service|package|monorepo|app|directory|folder|checkout|local checkout))+$"
)
_LEADING = re.compile(r"^(?:the|a|an|user's|users|the user's|local repo path for|local path for|user's local checkout of)\s+")
_PUNCT = re.compile(r"[^a-z0-9/._@:+# -]+")
_WS = re.compile(r"\s+")


def norm_text(s: str) -> str:
    s = (s or "").lower().strip()
    s = s.replace("\u2019", "'")
    s = _PUNCT.sub(" ", s)
    s = s.replace("-", " ").replace("_", " ")
    s = _WS.sub(" ", s).strip(" .")
    return s


def norm_subject(s: str) -> str:
    s = norm_text(s)
    if s in ("user", "the user", "abdullah", "users", "user s"):
        return "user"
    prev = None
    while prev != s:
        prev = s
        s = _LEADING.sub("", s)
        s = _GENERIC_SUFFIX.sub("", s).strip()
    return s or norm_text(s)


def norm_predicate(p: str) -> str:
    p = norm_text(p)
    p = re.sub(r"^(?:is|are)\s+(located|stored|hosted|found)\s+(?:at|in)$", "location", p)
    return p


def norm_object(o: str) -> str:
    return norm_text(o)
