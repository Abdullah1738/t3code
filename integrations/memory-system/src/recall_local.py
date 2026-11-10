"""Service-independent checks over the small, precompiled derived rules index.

No corpus, identity resolution or model imports are allowed on this path.
"""
import json
import os
from pathlib import Path
from recall_rules import RuleIndex, evaluate_conflict, filter_facts, dedupe_facts
from recall_classifier import deterministic


def preflight(tool, arguments, cwd, path=None, session_id=None):
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
    from recall_messages import outgoing, check
    messages = outgoing(tool, arguments, cwd)
    if messages:
        # Literal recipient/branch prohibitions retain precedence.
        index = RuleIndex(path)
        recipients = {arguments[k].casefold() for k in ('recipient', 'to', 'contact', 'chat', 'chat_name')
                      if isinstance(arguments.get(k), str) and arguments[k]}
        rules = [r for r in filter_facts(index.applicable(cwd, tool, arguments, candidates_only=True),
                                       " ".join(messages), session_id)
                 if not recipients or not r.get("recipient") or r["recipient"].casefold() in recipients]
        rules = dedupe_facts(rules)
        conflict = evaluate_conflict(rules, tool, arguments, cwd)
        if conflict:
            return rules, {**conflict, 'sources': conflict.get('citations', []), 'note': None}
        facts = [r for r in index.search_facts(messages, cwd, session_id=session_id)
                 if not r.get('recipient') or any(rule['id'] == r['id'] for rule in rules)]
        if facts:
            result = check(messages, facts)
            if result['decision'] == 'allow' and not result.get('note'):
                from recall_note import rule_note
                # Fact checks supplement the earlier explicit message guidance.
                guidance = [r for r in rules if r.get('specific_matched')]
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
