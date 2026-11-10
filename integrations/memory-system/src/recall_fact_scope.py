"""Provenance and point-in-time boundaries for transcript-derived facts."""
import re
import hashlib
import json


_AUTOMATION = (
    "You are a subagent", "You are the worker for a card", "You are the reviewer for a card",
    "You are an evaluator on the", "[coord]", "[crw]", "[Watcher event",
)


def automation(text):
    return text.lstrip().startswith(_AUTOMATION)


def owner_body(text):
    guidance_end = "[End of channel guidance. The owner's message follows.]"
    if guidance_end in text:
        text = text.split(guidance_end, 1)[1]
    return re.sub(r"<(system-reminder|recall|skill_content|environment_context)\b[^>]*>.*?</\1>",
                  "", text, flags=re.S)


def directive_body(text):
    text = re.sub(r"^\s*(?:[-*]|\d+\.)\s+", "", text.replace("’", "'"))
    return re.sub(r"^\s*(?:\[Abdullah\]\s*|(?:please|actually|no)[,:]?\s+)", "", text, flags=re.I)


def task_metadata(metadata):
    return bool(metadata.get('is_subagent') or metadata.get('parent_id') or metadata.get('parentID')
                or metadata.get('agent_id') or metadata.get('sidechain')
                or metadata.get('root_session_id') not in (None, metadata.get('native_id'))
                or metadata.get('origin') in ('board', 'delegated-task', 'subagent')
                or str(metadata.get('title', '')).lower().startswith('subagent:'))


def normalized(text):
    text = re.sub(r"\b[0-9a-f]{7,40}\b", "<id>", directive_body(text).casefold())
    return " ".join(re.sub(r"\d+", "<n>", text).split())


def standing_formulation(text):
    return bool(re.match(
        r"\s*(?:[-*]\s*)?(?:\[Abdullah\]\s*)?(?:remember (?:this|that)(?: for)? next time|"
        r"next time|from now on|owner rule:|always\b|never\b|"
        r"(?:don't|do not)\b[^.!?]{0,240}\bagain\b|a revision\b[^\n]*new essay)",
        directive_body(text), re.I))


def durable(text):
    # Transcript corrections default to their task. Only an explicit standing
    # formulation generalizes; saving with remember() remains an intentional scope.
    text = directive_body(text)
    if any(ci_ids(text)) or re.search(r"(?:/tmp/|tmp/|current head|translation rows)", text, re.I):
        return False
    return standing_formulation(text)


def ci_ids(text):
    return (
        set(re.findall(r"(?:\b(?:PR|pull request)\s*[:=#-]?\s*|/pull/)(\d+)", text, re.I)),
        {s.lower() for s in re.findall(r"\b[0-9a-f]{7,40}\b", text, re.I) if not s.isdigit()},
        set(re.findall(r"\b\d{10,}\b|\b\d{6}-\d{4}\b", text)),
    )


_CI_STATES = (r"success(?:ful(?:ly)?)?|succeed(?:ed|s)?|pass(?:ed|ing)?|fail(?:ed|ure|ing)?|"
              r"green|red|pending|queued|running|active|cancel(?:led|ed)|timed[_ -]?out|skipped|"
              r"neutral|completed|in[_ -]?progress|action[_ -]?required|blocked|waiting|error")


def standing_instruction(text):
    policy = re.sub(r"^(?:remember (?:this|that)(?: for)? next time|next time|from now on|owner rule)\s*[:,]?\s*",
                    "", directive_body(text), flags=re.I)
    # Policy wording determines intent; a named PR/head/run does not turn
    # an instruction into a historical result. Prefixes alone aren't intent:
    # "only PR1145 passed" and "never before had CI passed" are results.
    reference = r"(?:id\s*[:=#]?\s*|#\s*)?`?\d+`?"
    pr = r"(?:PR|pull request)\s*[:=#-]?\s*\d+"
    context = r"(?:\s+for\s+" + pr + r"(?:\s+head\s+`?[0-9a-f]{7,40}`?)?)?"
    result = r"(?:(?:is|was|are|were|has|had|did|will)|" + _CI_STATES + r")\b"
    # "Only run 123 passed" names a result; "only run 123 unless CI passed"
    # remains an instruction. Look past the reference before choosing intent.
    named_result = r"\s+" + reference + context + r"\s+" + result
    verb = (r"(?:(?:check|run)(?!" + named_result + r")|use|verify|wait|claim|say|report|mark|keep|reuse|avoid|ensure|require|confirm|inspect|test|"
            r"prefer|retain|review|send|push|deploy|merge|publish|record|write|stop|hold)\b")
    conditional = re.match(r"(?:if|unless|until|when|once|before|after)\b", policy, re.I)
    if conditional and re.search(r"\b(?:always|never|don't|do not|only)\s+" + verb +
                                 r"|(?:,\s*|\bthen\s+)(?:please\s+)?" + verb, policy, re.I):
        return True
    if re.search(r"\b(?:must|should|needs? to|required to)\s+(?:pass|succeed|be|run|finish|complete|remain|stay)\b", policy, re.I):
        return True
    if re.match(r"(?:always|never|don't|do not|only)\s+" + verb, policy, re.I):
        return True
    policy = re.sub(r"^(?:always|never|don't|do not|only)\s+", "", policy, flags=re.I)
    return standing_formulation(text) and bool(re.match(verb + r"|a revision\b[^\n]*new essay", policy, re.I))


def standing_text(text):
    parts = re.split(r"(?<=[.!?;])\s+|\n+", directive_body(text))
    if not parts or not standing_instruction(parts[0]):
        return ""
    return " ".join(p for p in parts if standing_instruction(p))


def comparison_text(fact, message):
    states = _CI_STATES
    state = r"(?<!\w)(?:" + states + r")(?!\w)"
    subject = r"(?:CI(?:checks?)?|checks?|workflows?|runs?)"
    saved, outgoing = ci_ids(fact), ci_ids(message)
    def outcome(part):
        if standing_instruction(part):
            return False
        # A result needs a CI/check/workflow/run subject; incidental identifiers
        # and status words in unrelated safeguards are not CI evidence.
        # Compact transcript spellings still need complete status words.
        part = re.sub(r"\b(" + subject + r")(?=(?:" + states + r")(?!\w))", r"\1 ", part, flags=re.I)
        # Keep the compact PR/head result form, rather than treating an ID
        # anywhere in a paragraph as evidence that every status describes CI.
        pr = r"(?:(?:PR|pull request)\s*[:=#-]?\s*\d+|https?://[^\s]+/pull/\d+)"
        if re.fullmatch(r"\s*" + pr + r"\s+head\s+`?[0-9a-f]{7,40}`?(?:\s*[:=—-]\s*|\s+)"
                        r"(?:(?:is|was|are|were|has|had|did|will)(?:\s+been)?\s+)?(?:" + states + r")[.!]?\s*", part, re.I):
            return True
        return bool(re.search(r"\b" + subject + r"\b.{0,100}" + state + r"|" + state + r".{0,100}\b" + subject + r"\b",
                              part, re.I | re.S))
    if not any(outcome(p) for p in re.split(r"(?<=[.!?;])\s+|\n+", fact)):
        return fact
    # CI claims are point-in-time. Unknown or mismatched identities cannot
    # deny a message; independently standing instructions remain available.
    fallback = standing_text(fact)
    if not (saved[1] or saved[2]):
        return fallback
    for kind, (ids, other) in enumerate(zip(saved, outgoing)):
        if not ids and not other:
            continue
        def same(a, b):
            return a == b or kind == 1 and (a.startswith(b) or b.startswith(a))
        if not ids or not other or not all(any(same(a, b) for b in other) for a in ids):
            return fallback
        if not all(any(same(a, b) for a in ids) for b in other):
            return fallback
    return fact


class TranscriptContext:
    def __init__(self, source):
        self.source = source
        self.columns = {r[1] for r in source.execute("PRAGMA table_info(episodic_events)")}
        self.rejected_sessions = set()
        self.aliases = {}
        self.alias_sources = {}
        self.cache = {}
        if source.execute("SELECT 1 FROM sqlite_master WHERE name='thread_aliases'").fetchone():
            columns = {r[1] for r in source.execute("PRAGMA table_info(thread_aliases)")}
            driver_column = 'driver' if 'driver' in columns else "''"
            for thread, native, agent, driver in source.execute(
                    "SELECT canonical_thread_id,native_id,agent_id," + driver_column + " FROM thread_aliases"):
                capture = {'claudeAgent': 'claude', 'claude': 'claude', 'codex': 'codex',
                           'muse': 'muse', 'opencode': 'opencode', 'hermes': 'hermes'}.get(driver)
                key = native + ":agent:" + agent if agent else native
                self.aliases.setdefault(key, set()).add(thread)
                if capture:
                    self.alias_sources.setdefault(key, set()).add(capture)
                if agent:
                    self.aliases.setdefault(agent, set()).add(thread)
                    if capture:
                        self.alias_sources.setdefault(agent, set()).add(capture)

        self.members = {}
        for native, threads in self.aliases.items():
            if len(threads) == 1:
                self.members.setdefault(next(iter(threads)), set()).add(native)
        self.signature = hashlib.sha256(json.dumps(
            sorted((key, sorted(values), sorted(self.alias_sources.get(key, []))) for key, values in self.aliases.items())).encode()).hexdigest()

    @staticmethod
    def task_opening(text):
        return owner_body(text).lstrip().startswith(_AUTOMATION[:4])

    def get(self, row):
        sid = row['session_id']
        source = row['source'] if 'source' in row.keys() else ''
        key = (source, sid)
        if key not in self.cache:
            mapped = self.aliases.get(sid, {sid} if sid in self.members else set())
            aliases = {sid}
            if len(mapped) == 1:
                thread = next(iter(mapped))
                aliases.update({thread} | self.members.get(thread, set()))
            rejected = bool(aliases & self.rejected_sessions) or any(t.startswith(('thread:delegated-task:', 'thread:subagent:')) or ':agent:' in t
                           for t in aliases | mapped)
            if rejected:
                self.cache[key] = (aliases, True)
                return self.cache[key]
            # Authorship belongs to the canonical thread too: a recovered native
            # session must inherit a board/subagent opening from its peers.
            for peer in sorted(aliases):
                captures = self.alias_sources.get(peer, {source}) if source else {''}
                for capture in sorted(captures):
                    where, args = ("source=? AND session_id=?", (capture, peer)) if capture else ("session_id=?", (peer,))
                    initial = self.source.execute(
                        "SELECT substr(content,1,65536),metadata_json FROM episodic_events WHERE " + where +
                        " AND speaker='user' AND content_type='text' ORDER BY id LIMIT 16", args).fetchall()
                    for opening in initial:
                        try:
                            metadata = json.loads(opening[1] or '{}')
                        except (TypeError, ValueError):
                            metadata = {}
                        if self.task_opening(opening[0]) or isinstance(metadata, dict) and task_metadata(metadata):
                            rejected = True
                            break
                    if rejected:
                        break
                if rejected:
                    break
            self.cache[key] = (aliases, rejected)
        return self.cache[key]
