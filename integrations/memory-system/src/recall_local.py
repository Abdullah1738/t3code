"""Service-independent checks over the small, precompiled derived rules index.

No corpus, identity resolution or model imports are allowed on this path.
"""
import json
import os
import sqlite3
import time
from pathlib import Path
from recall_rules import RuleIndex, evaluate_conflict, filter_facts, dedupe_facts, message_recipients, fact_terms, _tool_name, _SHELL_TOOLS
from recall_classifier import deterministic


def rule_preflight_enabled():
    """The pattern-matched rule index is off unless RECALL_RULE_PREFLIGHT=1.

    Owner, 2026-11-10: recall informs; it doesn't block tool calls or add rule
    notes from regex-extracted skill/transcript rules (the Crpko main-dev rule
    blocked pushes on the Robob fork). The code and recall_rules.db stay so the
    flag can restore it: set it for the recall server LaunchAgent and the hook
    environment.
    """
    return os.environ.get('RECALL_RULE_PREFLIGHT', '').strip() == '1'


def preflight(tool, arguments, cwd, path=None, session_id=None, *, _deadline=None):
    if not rule_preflight_enabled():
        return [], None
    deadline = _deadline if _deadline is not None else time.monotonic() + 1.3
    path = Path(path or os.environ.get('RECALL_RULES_DB', str(Path.home() / '.local/share/memory-system/data/recall_rules.db')))
    if isinstance(arguments, str):
        if tool.lower().split('__')[-1] in {'apply_patch', 'patch'}:
            arguments = {'input': arguments}
        else:
            try:
                arguments = json.loads(arguments)
            except ValueError:
                arguments = {'command': arguments}
    arguments = arguments if isinstance(arguments, dict) else {}
    if not path.exists():
        return [], None
    from recall_messages import outgoing, check, imessage_arguments, wrapped_calls
    wrapped = wrapped_calls(tool, arguments)
    calls = ([(name, fields) for name, fields in wrapped if outgoing(name, fields, cwd)]
             if wrapped else outgoing(tool, arguments, cwd, calls=True))
    if calls and calls != [(tool, arguments)]:
        # Normalizing the sends must not erase a prohibited push in the same
        # shell invocation. Check the original command before its message calls.
        if _tool_name(tool) in _SHELL_TOOLS:
            original = filter_facts(RuleIndex(path).applicable(cwd, tool, arguments, candidates_only=True),
                                    json.dumps(arguments), session_id)
            conflict = evaluate_conflict(original, tool, arguments, cwd)
            if conflict:
                return original, {**conflict, 'sources': conflict.get('citations', []), 'note': None}
        all_rules, results = [], []
        # Keep each body's recipient attached when a code-mode batch texts
        # several chats. A name in another message is not recipient evidence.
        for name, fields in calls:
            if time.monotonic() >= deadline:
                if all_rules:
                    results.append(check([], all_rules, timeout=0))
                break
            rules, result = preflight(name, fields, cwd, path, session_id, _deadline=deadline)
            all_rules.extend(rules)
            if result:
                results.append(result)
            if result and result['decision'] == 'deny':
                return dedupe_facts(all_rules), result
            if result and result.get('routed') and result.get('p') is None:
                return dedupe_facts(all_rules), result
        result = next((r for r in results if r.get('note')), results[0] if results else None)
        return dedupe_facts(all_rules), result
    arguments = imessage_arguments(tool, arguments, cwd)
    messages = outgoing(tool, arguments, cwd)
    if messages:
        # Literal recipient/branch prohibitions retain precedence.
        index = RuleIndex(path)
        recipients = message_recipients(arguments)
        rules = [r for r in filter_facts(index.applicable(cwd, tool, arguments, candidates_only=True),
                                       " ".join(messages), session_id)
                 if not r.get("recipient") or r["recipient"].casefold().strip() in recipients]
        rules = dedupe_facts(rules)
        conflict = evaluate_conflict(rules, tool, arguments, cwd)
        if conflict:
            return rules, {**conflict, 'sources': conflict.get('citations', []), 'note': None}
        # Explicit message rules are independent of the optional broad search's
        # deadline and row cap. Recipient rules also cover zero-overlap bodies.
        terms = fact_terms(' '.join(messages))
        facts = [r for r in rules if r.get('provenance') == 'explicit' and
                 (r.get('specific_matched') or
                  'message' in r['actions'] and terms & fact_terms(r['text']))]
        try:
            discovered = index.search_facts(messages, cwd, session_id=session_id)
        except (sqlite3.Error, TimeoutError):
            discovered = []
        facts = dedupe_facts(facts + [r for r in discovered
                                    if not r.get('recipient') or any(rule['id'] == r['id'] for rule in rules)])
        if facts:
            result = check(messages, facts, timeout=max(0, deadline - time.monotonic()))
            if result['decision'] == 'allow' and not result.get('note'):
                from recall_note import rule_note
                # Fact checks supplement the earlier explicit message guidance.
                checked = {r['id'] for r in facts}
                guidance = [r for r in rules if r.get('specific_matched') and r['id'] not in checked]
                result['note'], selected = rule_note(guidance)
                result['sources'] = [r['citation'] for r in selected]
            return facts, result
        return rules, None
    local = deterministic(tool, arguments) is False
    rules = filter_facts(RuleIndex(path).applicable(cwd, tool, arguments, explicit_only=local, candidates_only=True),
                         json.dumps(arguments), session_id)
    # These are the only sources that may produce tool notes. Global imported
    # prose alone is not a reason to spend a network round trip.
    rules = dedupe_facts(rules)
    rules = [r for r in rules if r.get('path_matched') or r.get('provenance') == 'explicit' or r.get('constraints')
             or r.get('provenance') == 'owner_correction' and r.get('recipient')]
    conflict = evaluate_conflict(rules, tool, arguments, cwd)
    if conflict:
        return rules, {**conflict, 'sources': conflict.get('citations', []), 'note': None}
    if deterministic(tool, arguments) is False:
        rules = [r for r in rules if r.get('provenance') == 'explicit' or r.get('path_matched')]
    return rules, None


def local_note(rules):
    from recall_note import rule_note
    matched = [r for r in rules if r.get('specific_matched') and r.get('citation')]
    if not matched: return None
    compact = [{**r, 'text': 'Harness parity: agent tooling must reach OpenCode, Claude Code, Codex and codex-cu. Load the harness-config-parity skill and verify every harness.'}
               if 'harness-config-parity' in r['text'] else r for r in matched]
    # Imported copies can repeat the same instruction; cite the strongest one.
    compact = list({r['text']: r for r in reversed(compact)}.values())
    note, selected = rule_note(compact)
    if not note or not selected: return None
    return {'decision':'allow', 'note':note, 'sources':[r['citation'] for r in selected], 'classifier':'path-rule', 'recall_ran':True}

def main():
    import sys
    body = json.load(sys.stdin)
    try:
        rules, conflict = preflight(body['tool'], body.get('arguments'), body.get('cwd', ''), session_id=body.get('session_id'))
        print(json.dumps({'candidate': bool(rules), 'result': conflict or local_note(rules)}))
    except Exception:
        # Only literal, cited conflicts fail closed. Optional context fails open.
        print(json.dumps({'candidate': False, 'result': None, 'error': 'local-index-unavailable'}))


if __name__ == '__main__':
    main()
