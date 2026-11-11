"""Provenance and point-in-time boundaries for transcript-derived facts."""
import re
import hashlib
import json
from functools import lru_cache
from pathlib import Path


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


def directive_prefix(text):
    return re.sub(r"^\s*(?:[-*]|\d+\.)\s+", "", text.replace("’", "'"))


def directive_body(text):
    text = directive_prefix(text)
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
    # Link destinations can carry additional PR/head/run identities. Only strip
    # inline formatting here; outcome recognition uses the displayed label.
    text = inline_text(text)
    return (
        set(re.findall(r"(?:\b(?:PR|pull request)\s*[:=#-]?\s*|/pull/)(\d+)", text, re.I)),
        {s.lower() for s in re.findall(r"\b[0-9a-f]{7,40}\b", text, re.I) if not s.isdigit()},
        set(re.findall(r"\b\d{10,}\b|\b\d{6}-\d{4}\b", text)),
    )


_CI_STATES = (r"success(?:ful(?:ly)?)?|succeed(?:ed|s)?|pass(?:ed|ing)?|fail(?:ed|ure|ing)?|"
              r"green|red|pending|queued|running|active|cancel(?:led|ed)|timed[_ -]?out|skipped|"
              r"neutral|completed|finish(?:ed|es)?|ship(?:ped|s)?|in[_ -]?progress|action[_ -]?required|blocked|waiting|error")


def inline_text(text):
    for _ in range(4):
        plain = re.sub(r"(`+)([^`\n]+)\1", r"\2", text)
        plain = re.sub(r"(?<!\w)(\*\*|__|\*|_)(?=\S)(.+?)(?<=\S)\1(?!\w)", r"\2", plain)
        if plain == text:
            break
        text = plain
    return text


def presentation_text(text):
    return inline_text(re.sub(r"\[([^\]\n]+)\]\([^\n)]+\)", r"\1", text))


def describes_result(text):
    reference = r"(?:id\s*[:=#]?\s*|#\s*)?\d+"
    pr = r"(?:PR|pull request)\s*[:=#-]?\s*\d+"
    context = r"(?:\s+for\s+" + pr + r"(?:\s+head\s+[0-9a-f]{7,40})?)?"
    result = r"(?:(?:is|was|are|were|has|had|did|will)|" + _CI_STATES + r")\b"
    subject = r"(?:(?:check|run)\s+" + reference + r"|(?:commit|head|sha)\s+[0-9a-f]{7,40})"
    ci = r"(?:(?:CI(?:checks?)?|checks?|workflows?|runs?)\s*)?"
    if re.match(subject + context + r"\s+" + ci + result, text, re.I):
        return True
    bare_result = r"(?:(?:is|was|are|were|has|had|did|will)(?:\s+been)?\s+)?(?:" + _CI_STATES + r")\b"
    if re.match(r"(?:run|check)\s+" + bare_result + r"(?=\s+for\b|\s*[.!?;]?$)", text, re.I):
        return True
    # Reject descriptive subjects and temporal reports, rather than listing
    # every verb an owner may use in a prohibition or conditional instruction.
    return bool(re.match(
        r"(?:PR\s*[:=#-]?\s*\d+|pull request\b|CI(?:checks?)?\b|checks\b|workflows?\b|runs\b|"
        r"(?:I|we|you|they|he|she|it|this|that|the|a|an|our|both|all|one|two|before|after|when|once|if|unless|until|"
        r"yesterday|previously|already|has|had|have|was|were|is|are|did)\b)", text, re.I))


_MODAL = (r"(?:always|never|don't|do not|only|must(?: not)?|should(?: not)?|cannot|can't|"
          r"need to|have to|make sure|remember to)")


@lru_cache(maxsize=1)
def base_verbs():
    return frozenset(w.split()[0] for w in Path(__file__).with_name('english_verbs.txt').read_text().splitlines()
                     if w and not w.startswith('#'))


@lru_cache(maxsize=1)
def noun_verbs():
    return frozenset(word for line in Path(__file__).with_name('english_verbs.txt').read_text().splitlines()
                     if line.startswith('# N ') for word in line[4:].split())


def base_verb(word):
    word = word.casefold()
    return word in base_verbs() or word.startswith('re') and word[2:] in base_verbs()


def nominal_instruction(text):
    if not text or describes_result(text):
        return False
    words = re.findall(r"[a-z]+", text.casefold())
    # A prohibition's nominal object has no finite predicate. Recognize
    # inflections through the same lexicon instead of enumerating noun subjects.
    for word in words[1:]:
        if word in {'for', 'unless', 'until', 'before', 'after', 'without', 'while'}:
            break
        if word in {'is', 'are', 'was', 'were', 'has', 'have', 'had', 'does', 'did'}:
            return False
        if word.endswith(('s', 'ed')):
            stems = [word[:-1], word[:-2], word[:-3] + 'y', word[:-1] + 'e']
            if any(stem in base_verbs() for stem in stems):
                return False
    return True


def finite_result_clause(text):
    clause = re.match(r"([a-z]+)\s+(" + _CI_STATES + r"|[a-z]+)\b(.*)", text, re.I)
    if not clause or clause[1].casefold() not in noun_verbs():
        return False
    predicate, tail = clause[2].casefold().split()[0], clause[3].strip()
    if predicate in {'is', 'are', 'was', 'were', 'has', 'have', 'had', 'does', 'did', 'will'}:
        return True
    finite = False
    if predicate.endswith('ed'):
        stem = predicate[:-2]
        roots = {stem, stem + 'e', predicate[:-3] + 'y'}
        if len(stem) > 1 and stem[-1] == stem[-2]:
            roots.add(stem[:-1])
        finite |= bool(roots & base_verbs())
    if predicate.endswith('s'):
        roots = {predicate[:-1], predicate[:-2], predicate[:-3] + 'y'} & base_verbs()
        outcome = bool(re.fullmatch(_CI_STATES, predicate)) or any(
            re.fullmatch(_CI_STATES, root + ending) for root in roots for ending in ('d', 'ed'))
        # A lexical noun plural is a command object unless it carries an
        # established outcome meaning. Inflection alone cannot turn
        # "release changes" or "build packages" into historical reports.
        complement = bool(re.match(r"(?:in|from)\b", tail, re.I))
        finite |= bool(roots) and (not roots & noun_verbs() or outcome or complement)
    # A finite result after a noun/verb homograph is a report. A participle
    # modifying its object ("release completed builds") remains imperative;
    # plural objects such as "results" are not result predicates.
    return finite and bool(re.fullmatch(r"[.!?]*", tail) or re.match(
        r"(?:for|on|in|at|by|from|to|with|without|after|before|and|but|the|a|an)\b|[a-z]+ly\b", tail, re.I))


def directive_clause(text):
    polite = bool(re.match(r"\s*(?:\[Abdullah\]\s*)?(?:actually[,\s:]+)?please\b",
                           directive_prefix(text), re.I))
    prefix = re.sub(r"^\s*(?:\[Abdullah\]\s*|(?:please|actually)[,:]?\s+)", "",
                    directive_prefix(text), flags=re.I).strip()
    if re.match(r"No\s+", prefix, re.I):
        nominal = re.sub(r"^No\s+", "", prefix, flags=re.I)
        return nominal_instruction(nominal)
    text = directive_body(text).strip()
    modal = re.match(_MODAL + r"\s+", text, re.I)
    if modal:
        text = text[modal.end():]
    if re.match(r"a revision\b[^\n]*new essay", text, re.I):
        return True
    if modal and modal[0].strip().lower() == 'make sure':
        return bool(text)
    if not text or describes_result(text):
        return False
    head = re.match(r"[a-z]+\b", text, re.I)
    if modal:
        return bool(head and (modal[0].strip().lower() != 'only' or
                              base_verb(head[0]) and not finite_result_clause(text)))
    if polite:
        return bool(head and base_verb(head[0]))
    # Use a fixed English lexicon for unmarked imperatives, not a growing
    # list of command objects or report subjects. Explicit modals do not
    # depend on vocabulary coverage; unknown non-CI facts still stay kept.
    return bool(head and base_verb(head[0]) and not finite_result_clause(text))


def conditional_instruction(text):
    if not re.match(r"(?:if|unless|until|when|once|before|after)\b", text, re.I):
        return False
    parts = re.split(r",|\bthen\b", text, maxsplit=1, flags=re.I)
    if len(parts) == 2:
        return directive_clause(parts[1])
    modal = re.search(r"\b" + _MODAL + r"\s+.+", text, re.I)
    return bool(modal and directive_clause(modal[0]))


def standing_instruction(text):
    presented = presentation_text(text)
    prefix = re.sub(r"^\s*(?:\[Abdullah\]\s*|(?:please|actually)[,:]?\s+)", "",
                    directive_prefix(presented), flags=re.I)
    negative = bool(re.match(r"\s*No\b", prefix, re.I))
    policy = re.sub(r"^(?:remember (?:this|that)(?: for)? next time|next time|from now on|owner rule)\s*[:,]?\s*",
                    "", directive_body(presented), flags=re.I)
    if conditional_instruction(policy):
        return True
    if re.search(r"\b(?:must|should|needs? to|required to)\s+(?:pass|succeed|be|run|finish|complete|remain|stay)\b", policy, re.I):
        return True
    if negative:
        nominal = re.sub(r"^No\s+", "", directive_body(policy), flags=re.I)
        return nominal_instruction(nominal)
    if re.match(_MODAL + r"\s+", policy, re.I):
        remainder = re.sub(r"^" + _MODAL + r"\s+", "", policy, flags=re.I)
        return conditional_instruction(remainder) or directive_clause(policy)
    return standing_formulation(presentation_text(text)) and directive_clause(policy)


def standing_text(text):
    parts = re.split(r"(?<=[.!?;])\s+|\n+", directive_prefix(text))
    if not parts or not standing_instruction(parts[0]):
        return ""
    return " ".join(p for p in parts if standing_instruction(p))


def comparison_text(fact, message):
    states = _CI_STATES
    state = r"(?<!\w)(?:" + states + r")(?!\w)"
    subject = r"(?:CI(?:checks?)?|checks?|workflows?|runs?)"
    saved, outgoing = ci_ids(fact), ci_ids(message)
    def outcome(part):
        part = presentation_text(part)
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
