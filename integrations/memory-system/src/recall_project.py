"""Which project a directory belongs to: repository, remotes and checkout source.

This is context for the recall model, so it can tell which memories apply
where. It never blocks anything. Resolution reads git metadata directly (no git
process in the common case) and is cached per repository config.
"""
from __future__ import annotations

import os
import re
import subprocess
import time
from pathlib import Path
from urllib.parse import urlsplit

# A GitHub-style owner segment is the strongest evidence: it survives SSH host
# aliases, mirrors on other hosts and URL rewrites.
OWNER_PROJECTS = {"equicom-crypto": "Crpko (Equicom-Crypto org)"}
ROBOB = "Robob (Abdullah's t3code fork)"
REPO_PROJECTS = {("abdullah1738", "robob-mission-control"): ROBOB, ("abdullah1738", "t3code"): ROBOB,
                 ("pingdotgg", "t3code"): ROBOB}
# Fallback only, for a checkout whose remotes name nothing.
KNOWN_ROOTS = {"/Volumes/ExternalSSD/t3code-fork": ROBOB}
_CACHE: dict = {}


def _abs(value: str) -> str:
    return os.path.abspath(os.path.expanduser(value)) if value else ""


def _read(path: Path, limit: int = 1 << 20) -> str:
    with open(path, encoding="utf-8", errors="replace") as handle:
        return handle.read(limit)


def _inside(root: str, path: str) -> bool:
    return path == root or path.startswith(root.rstrip("/") + "/")


def git_location(cwd: str):
    """(worktree root, common git dir) for cwd without spawning git, else None.

    Handles plain clones, linked worktrees, ovnfs checkouts (`.git` file
    pointing at a private git dir) and bare repositories.
    """
    try:
        start = Path(_abs(cwd))
        for directory in (start, *start.parents):
            marker = directory / ".git"
            if marker.is_dir():
                git = marker
            elif marker.is_file():
                match = re.match(r"gitdir:\s*(.+)", _read(marker, 4096).strip())
                if not match:
                    return None
                git = Path(match[1].strip())
                git = git if git.is_absolute() else directory / git
            elif (directory / "HEAD").is_file() and (directory / "config").is_file() and (directory / "objects").is_dir():
                return directory, directory
            else:
                continue
            common = git
            if (git / "commondir").is_file():
                pointer = Path(_read(git / "commondir", 4096).strip())
                common = pointer if pointer.is_absolute() else git / pointer
            return directory, Path(os.path.normpath(common))
    except (OSError, ValueError):
        return None
    return None


def remote_repo(url: str) -> str | None:
    """'owner/name' (lowercase) for a remote URL, or None for local paths and odd transports."""
    url = url.strip().strip('"').strip()
    if not url or url.startswith(("/", ".", "~", "file:")) or "::" in url:
        return None
    if "://" in url:
        try:
            path = urlsplit(url).path
        except ValueError:
            return None
    else:
        match = re.match(r"^(?:[^@/\s]+@)?[^/:\s]+:(.+)$", url)  # scp-like host:owner/name
        if not match:
            return None
        path = match[1]
    parts = [part for part in path.strip("/").split("/") if part]
    if len(parts) < 2:
        return None
    for part in parts[:-1]:
        if part.lower() in OWNER_PROJECTS:
            return part.lower() + "/" + re.sub(r"\.git$", "", parts[-1].lower())
    return parts[-2].lower() + "/" + re.sub(r"\.git$", "", parts[-1].lower())


def _clean(value: str) -> str:
    """Repository metadata is data: keep it to plain path/name characters."""
    return re.sub(r"[^\w./:@+ -]", "", value)[:200]


def _redact_url(url: str) -> str:
    """A remote URL without credentials, query or fragment (only host and path survive)."""
    url = (url or "").strip()
    if "://" in url:
        try:
            parts = urlsplit(url)
            host = parts.hostname or ""
            if parts.port:
                host += f":{parts.port}"
            return f"{parts.scheme}://{host}{parts.path}"
        except ValueError:
            return ""
    # scp-like user@host:path: drop the user part
    return re.sub(r"^[^/@:]+@", "", url.split("?", 1)[0].split("#", 1)[0])


def _line(value) -> str:
    """One line of plain text: no control characters, bounded."""
    return re.sub(r"[\x00-\x1f\x7f]+", " ", str(value or ""))[:300]


MAX_REMOTES = 8
MAX_DESCRIBE = 2000


def project_of_repo(repo: str | None) -> str | None:
    if not repo:
        return None
    owner, _, name = repo.partition("/")
    return REPO_PROJECTS.get((owner, name)) or OWNER_PROJECTS.get(owner)


def config_remotes(common: Path) -> dict:
    """remote name -> [url, pushurl...] from the repository config."""
    text = _read(common / "config")
    if re.search(r"^\s*\[\s*include", text, re.I | re.M):
        # Included files are rare; let git resolve them (bounded).
        result = subprocess.run(["git", "--git-dir", str(common), "config", "--get-regexp", r"^remote\..*\.(url|pushurl)$"],
                                capture_output=True, text=True, timeout=0.3)
        remotes: dict = {}
        for line in result.stdout.splitlines():
            key, _, value = line.partition(" ")
            remotes.setdefault(key.split(".", 1)[-1].rsplit(".", 1)[0], []).append(value)
        return remotes
    remotes, current = {}, None
    for line in text.splitlines():
        line = line.strip()
        if not line or line[0] in "#;":
            continue
        section = re.match(r'^\[\s*([^\]\s"]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]', line)
        if section:
            current = section[2] if section[1].lower() == "remote" and section[2] is not None else None
            continue
        if current is None:
            continue
        key, _, value = line.partition("=")
        if key.strip().lower() in ("url", "pushurl"):
            remotes.setdefault(current, []).append(re.split(r"\s[#;]", value.strip(), maxsplit=1)[0].strip())
    return remotes


def _source_repo(common: Path) -> str | None:
    """The repository a checkout borrows objects from (ovnfs, `clone --reference`)."""
    try:
        lines = _read(common / "objects/info/alternates", 65536).splitlines()
    except OSError:
        return None
    for line in lines:
        objects = Path(line.strip())
        if line.strip() and objects.is_absolute():
            source = objects.parent  # <repo>/.git/objects or <bare>/objects
            return str(source.parent if source.name == ".git" else source)
    return None


def resolve(cwd: str, depth: int = 0) -> dict:
    """{'cwd', 'root', 'remotes': {name: owner/name or url}, 'project', 'checkout_of'}.

    project is a readable label ("Crpko (Equicom-Crypto org)", "Robob ...",
    "github repo owner/name") or None when nothing says which project this is.
    """
    cwd = _abs(cwd)
    result = {"cwd": cwd, "root": None, "remotes": {}, "project": None, "checkout_of": None}
    location = git_location(cwd) if cwd else None
    if not location:
        result["project"] = next((label for root, label in KNOWN_ROOTS.items() if _inside(root, cwd)), None) if cwd else None
        return result
    root, common = location
    try:
        info = (common / "config").stat()
        key = (str(common), str(root), info.st_mtime_ns, info.st_size, depth)
    except OSError:
        key = None
    if key and key in _CACHE:
        return {**_CACHE[key], "cwd": cwd}
    result["root"] = str(root)
    try:
        remotes = config_remotes(common) if key else {}
        # Included files can change without touching the main config: don't cache those.
        if key and re.search(r"^\s*\[\s*include", _read(common / "config"), re.I | re.M):
            key = None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        remotes = {}
    labels = []
    for name, urls in list(remotes.items())[:MAX_REMOTES]:
        repos = [remote_repo(url) for url in urls]
        named = [repo for repo in repos if repo]
        result["remotes"][_clean(name)] = _clean(named[0] if named and len(set(named)) == 1 and len(named) == len(repos) else ", ".join(
            repo or _redact_url(url) for repo, url in zip(repos, urls)))
        labels.extend(project_of_repo(repo) or "" for repo in named)
    source = _source_repo(common)
    if source and _abs(source) != str(root):
        result["checkout_of"] = source
        if not remotes and depth < 2:
            borrowed = resolve(source, depth + 1)
            result["remotes"], result["project"] = borrowed["remotes"], borrowed["project"]
            key = None  # the source repo's config decides; it is cached on its own key
    crpko = [label for label in labels if label.startswith("Crpko")]
    known = [label for label in labels if label]
    if crpko:
        result["project"] = crpko[0]
    elif known:
        result["project"] = known[0]
    elif not result["project"]:
        result["project"] = next((label for path, label in KNOWN_ROOTS.items() if _inside(path, str(root))), None)
        if not result["project"] and result["remotes"]:
            first = next(iter(result["remotes"].values()))
            result["project"] = f"repo {first}" if "/" in first and "," not in first else None
    if key:
        if len(_CACHE) > 256:
            _CACHE.clear()
        _CACHE[key] = dict(result)
    return result


def describe(cwd: str | None) -> str:
    """A few plain lines about where the agent is working, for the recall model."""
    if not cwd:
        return ""
    info = resolve(cwd)
    lines = [f"Working directory: {_line(info['cwd'])}"]
    if info["root"]:
        lines.append(f"Repository: {_line(info['root'])}")
    if info["checkout_of"]:
        lines.append(f"Checkout of: {_line(info['checkout_of'])}")
    if info["remotes"]:
        lines.append(_line("Remotes: " + ", ".join(f"{name}={repo}" for name, repo in sorted(info["remotes"].items()))[:1000]))
    lines.append("Project: " + _line(info["project"] or ("unknown" if info["root"] else "not inside a repository")))
    return "\n".join(lines)[:MAX_DESCRIBE]


def label(cwd: str | None) -> str:
    """Short project label for an excerpt's session directory ('' when unknown)."""
    if not cwd:
        return ""
    try:
        return resolve(cwd)["project"] or ""
    except Exception:  # noqa: BLE001 - context only
        return ""


def labels(cwds, budget: float = 0.15) -> dict:
    """Project labels for several directories within a small time budget."""
    out, deadline = {}, time.monotonic() + budget
    for cwd in dict.fromkeys(c for c in cwds if c):
        if time.monotonic() > deadline:
            break
        out[cwd] = label(cwd)
    return out
