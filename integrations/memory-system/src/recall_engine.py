"""One trigger engine shared by all harnesses; corpus indexing is never on-path."""
import json
import hashlib
import copy
import os
import threading
import time
from collections import OrderedDict
from pathlib import Path

import recall_core as rc
from recall_classifier import classify
from recall_note import bounded_note, rule_note

RULES_DB = Path(os.environ.get("RECALL_RULES_DB", rc.DATA / "recall_rules.db"))


class CheckEngine:
    def __init__(self, rules_path=None, classifier=classify):
        self.rules_path = Path(rules_path or RULES_DB)
        self.classifier = classifier
        self.cache = OrderedDict()
        self.lock = threading.Lock()
        self.log_lock = threading.Lock()
        self.verdicts = OrderedDict()

    def _rules(self, cwd, tool, arguments, *, explicit_only=False, session_id=None, text=""):
        from recall_local import rule_preflight_enabled
        if not rule_preflight_enabled():
            return [], None
        if not self.rules_path.exists():
            return [], "rules index missing"
        from recall_rules import RuleIndex, filter_facts, dedupe_facts
        index = RuleIndex(self.rules_path)
        try:
            return dedupe_facts(filter_facts(index.applicable(cwd, tool, arguments, explicit_only=explicit_only),
                                              text or json.dumps(arguments), session_id)), None
        finally:
            close = getattr(index, "close", None)
            if close:
                close()

    def preflight(self, body):
        started = time.monotonic()
        tool = str(body.get("tool") or "")[:300]
        arguments = body.get("arguments") or {}
        arguments = arguments if isinstance(arguments, dict) else {"input": str(arguments)[:16000]}
        cwd = str(body.get("cwd") or "")[:2000]
        error = None
        if body.get("trigger") == "tool":
            from recall_local import preflight, local_note
            try:
                rules, conflict = preflight(tool, arguments, cwd, self.rules_path, session_id=body.get("session_id"))
            except Exception as exc:
                rules, conflict, error = [], None, type(exc).__name__
            note = local_note(rules)
            if note and not conflict:
                return rules, error, self._finish({**note, "trigger":"tool", "cwd":cwd, "p":1, "cost":0}, tool, started)
            if conflict:
                result = {"decision": "deny", "note": None, "sources": conflict.get("sources", []),
                          "trigger": "tool", "cwd": cwd, "recall_ran": True, "p": 1, "cost": 0,
                          "classifier": "owner-rule", **conflict}
                return rules, error, self._finish(result, tool, started)
        else:
            rules, error = self._rules(cwd, tool, arguments, session_id=body.get("session_id"), text=str(body.get("prompt") or ""))
        return rules, error, None

    def check(self, body, preflight=None):
        started = time.monotonic()
        trigger = body.get("trigger")
        if trigger not in {"first_prompt", "compaction", "tool"}:
            return {"decision": "allow", "note": None, "skipped": "unsupported trigger", "sources": []}
        tool = str(body.get("tool") or "")[:300]
        arguments = body.get("arguments") or {}
        if not isinstance(arguments, dict):
            arguments = {"input": str(arguments)[:16000]}
        cwd = str(body.get("cwd") or "")[:2000]
        rules, rule_error, denied = preflight if preflight is not None else self.preflight(body)
        if denied:
            return denied
        route = {"check": True, "p": 1.0, "cost": 0, "latency_ms": 0, "classifier": "trigger"}
        explicit = [r["triggers"] for r in rules if r.get("provenance") in {"explicit"}]
        if trigger == "tool" and not rules:
            return self._finish({"decision": "allow", "note": None, "sources": [],
                                 "recall_ran": False, "trigger": trigger, "cwd": cwd,
                                 "classifier": "deterministic", "p": 0, "cost": 0,
                                 "skipped": "regular local work"}, tool, started)
        if trigger == "tool":
            route = self._classify(tool, arguments, cwd)
        result = {"decision": "allow", "reason": "", "note": None, "sources": [], "recall_ran": False,
                  "trigger": trigger, "cwd": cwd, **route}
        if rule_error:
            result["rules_error"] = rule_error
        if not route["check"]:
            result["skipped"] = "regular local work"
            return self._finish(result, tool, started)
        from recall_rules import evaluate_conflict
        conflict = evaluate_conflict(rules, tool, arguments, cwd) if trigger == "tool" else None
        if conflict:
            result.update(conflict)
            result["sources"] = conflict.get("sources") or conflict.get("citations") or []
            result["decision"] = "deny"
            result["recall_ran"] = True
            return self._finish(result, tool, started)
        if trigger != "tool":
            # A prompt is not a request to enumerate all globally scoped skills.
            from recall_rules import _tokens, _STOP
            context = _tokens(str(body.get("prompt") or "")) - _STOP
            rules = [r for r in rules if len(context & (_tokens(r["text"]) - _STOP)) >= 2]
        if trigger == "tool":
            # Imported global skills are background guidance. Argument word
            # overlap cannot establish that a card/payment rule applies to git.
            rules = [r for r in rules if (r.get("provenance") == "explicit" or (r.get("provenance") == "owner_correction" and r.get("recipient")))
                     or bool(r.get("constraints"))]
        if rules:
            result["note"], selected = rule_note(rules)
            result["sources"] = [r.get("citation") or r.get("source") for r in selected]
            result["recall_ran"] = bool(selected)
        # First-prompt/compaction history is strictly bounded. An outward call
        # always checks rules above, even when optional transcript work is shed.
        if trigger != "tool" and time.monotonic() - started < 1.8 and body.get("session_id"):
            prompt = str(body.get("prompt") or "")[:6000]
            if trigger == "tool":
                prompt = "remember earlier owner corrections " + tool + " " + json.dumps(arguments, default=str)[:3000]
            try:
                from recall_admission import cheap_note
                note = cheap_note(prompt, session_id=str(body["session_id"]), parent_id=body.get("parent_id"), cwd=cwd or None,
                                  caller_thread=body.get("caller_thread"), caller_native=body.get("caller_native"),
                                  caller_driver=body.get("caller_driver"), caller_agent=body.get("caller_agent"))
                result["recall_ran"] = True
                if note.get("note") and not result["note"]:
                    combined = "\n".join(x for x in (result["note"], note["note"]) if x)
                    if bounded_note(combined):
                        result["note"] = combined
                        result["sources"].extend(note.get("sources") or [])
            except Exception as exc:
                result["skipped"] = type(exc).__name__
            finally:
                rc.close_readers()
        return self._finish(result, tool, started)

    def _classify(self, tool, arguments, cwd):
        # Keep argument values intact: recipients, bodies and branch names are
        # semantic. Canonical JSON only removes object-key ordering differences.
        generation = []
        for path in (self.rules_path, Path(str(self.rules_path) + "-wal")):
            try:
                st = path.stat()
                generation.append((st.st_ino, st.st_mtime_ns, st.st_size))
            except OSError:
                generation.append(None)
        key = hashlib.sha256(json.dumps([generation, tool.lower(), arguments, cwd], sort_keys=True, default=str).encode()).digest()
        now = time.monotonic()
        with self.lock:
            hit = self.verdicts.get(key)
            if hit and now - hit[0] < 60:
                return {**hit[1], "classifier": "jev-cache", "cost": 0, "routed": False}
        result = self.classifier(tool, arguments, rule_triggers=(), timeout=0.9, candidates=True)
        with self.lock:
            if result.get("p") is not None:
                self.verdicts[key] = (now, dict(result))
                while len(self.verdicts) > 2048:
                    self.verdicts.popitem(last=False)
        return {**result, "routed": True}

    def cached_check(self, body, preflight=None):
        request_id = body.get("request_id") or body.get("tool_call_id") or body.get("compaction_id")
        if not request_id:
            return self.check(body, preflight)
        try:
            info = self.rules_path.stat()
            generation = (info.st_ino, info.st_mtime_ns, info.st_size)
            wal = self.rules_path.with_name(self.rules_path.name + "-wal")
            if wal.exists():
                info = wal.stat()
                generation += (info.st_mtime_ns, info.st_size)
        except OSError:
            generation = ()
        from recall_local import rule_preflight_enabled
        # A result cached while the rule index was on must not outlive turning it off.
        key = hashlib.sha256(json.dumps([body, generation, rule_preflight_enabled()], sort_keys=True, default=str).encode()).hexdigest()
        with self.lock:
            hit = self.cache.get(key)
            if hit and time.monotonic() - hit[0] < 60:
                result = copy.deepcopy(hit[1])
                result["cached"] = True
                result["routed"] = False
                result["classifier"] = "request-cache"
                return self._finish(result, str(body.get("tool") or "")[:300], time.monotonic())
        result = self.check(body, preflight)
        with self.lock:
            self.cache[key] = (time.monotonic(), copy.deepcopy(result))
            while len(self.cache) > 2048:
                self.cache.popitem(last=False)
        return result

    def fallback(self, body, result, rules=()):
        result.update(trigger=body.get("trigger"), cwd=str(body.get("cwd") or "")[:2000], p=None, cost=0,
                      classifier="load-shed", recall_ran=False, reason="")
        # Saturation never bypasses the outward gate. Cited denials already
        # returned from preflight; optional context may safely be omitted.
        result["note"], result["sources"] = None, []
        return self._finish(result, str(body.get("tool") or "")[:300], time.monotonic())

    def _finish(self, result, tool, started):
        result["note"] = bounded_note(result.get("note"))
        result["latency_ms"] = int((time.monotonic() - started) * 1000)
        record = {key: result.get(key) for key in ("trigger", "p", "cost", "latency_ms", "classifier", "recall_ran", "decision", "sources", "rules_error", "reason", "cwd")}
        record.update(routed=result.get("routed", False), local_decision=result.get("classifier"), routing_reason="matching-rule" if result.get("routed") else result.get("skipped", result.get("classifier")), tool=tool, note=bool(result.get("note")), at=int(time.time()))
        path = Path(os.environ.get("RECALL_DECISION_LOG", rc.ROOT / "logs/recall-decisions.jsonl"))
        try:
            with self.log_lock:
                path.parent.mkdir(parents=True, exist_ok=True)
                if path.exists() and path.stat().st_size > 20 * 1024 * 1024:
                    path.replace(path.with_suffix(".jsonl.1"))
                with path.open("a") as stream:
                    stream.write(json.dumps(record) + "\n")
        except OSError:
            pass
        return result
