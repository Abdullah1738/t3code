"""Reconstruct nested hook events from retained code-mode cells, never run JS."""
import ast
import json
import re


class Unresolved(ValueError):
    pass


def _tokens(source):
    index = 0
    while index < len(source):
        char = source[index]
        if char.isspace():
            index += 1
        elif source.startswith("//", index):
            end = source.find("\n", index)
            index = len(source) if end < 0 else end
        elif source.startswith("/*", index):
            end = source.find("*/", index + 2)
            if end < 0:
                raise Unresolved("unterminated JavaScript comment")
            index = end + 2
        elif char in "\"'`":
            end = index + 1
            while end < len(source) and source[end] != char:
                end += 2 if source[end] == "\\" else 1
            if end >= len(source):
                raise Unresolved("unterminated JavaScript string")
            literal = source[index:end + 1]
            try:
                if char == '"':
                    value = json.loads(literal)
                elif char == "'":
                    value = ast.literal_eval(literal)
                elif "${" not in literal:
                    value = json.loads('"' + literal[1:-1].replace('"', '\\"').replace("\n", "\\n") + '"')
                else:
                    value = None
            except (SyntaxError, ValueError):
                value = None
            yield "string", value
            index = end + 1
        elif match := re.match(r"[A-Za-z_$][\w$]*", source[index:]):
            yield "word", match[0]
            index += len(match[0])
        else:
            yield "punct", char
            index += 1


def commands(source, fallback_cwd):
    """Return each explicit command/cwd; reject dynamic command argument objects."""
    if len(source) > 2_000_000:
        raise Unresolved("code-mode input exceeds the source limit")
    tokens = list(_tokens(source))
    result = []
    for start in range(len(tokens) - 3):
        if tokens[start:start + 4] != [("word", "tools"), ("punct", "."), ("word", "exec_command"), ("punct", "(")]:
            continue
        index = start + 4
        if tokens[index:index + 1] != [("punct", "{")]:
            raise Unresolved("non-literal exec_command argument object")
        index += 1
        fields = {}
        while tokens[index:index + 1] != [("punct", "}")]:
            if index >= len(tokens) or tokens[index][0] not in {"word", "string"} or not isinstance(tokens[index][1], str):
                raise Unresolved("computed or spread exec_command property")
            key = tokens[index][1]
            index += 1
            if tokens[index:index + 1] != [("punct", ":")]:
                raise Unresolved("non-literal exec_command property " + repr(key[:80]))
            index += 1
            first, nesting = index, []
            while index < len(tokens):
                kind, value = tokens[index]
                if not nesting and kind == "punct" and value in {",", "}"}:
                    break
                if kind == "punct" and value in {"{", "[", "("}:
                    nesting.append({"{": "}", "[": "]", "(": ")"}[value])
                elif kind == "punct" and value in {"}", "]", ")"}:
                    if not nesting or nesting.pop() != value:
                        raise Unresolved("unbalanced exec_command argument object")
                index += 1
            if key in {"cmd", "workdir", "cwd"}:
                value = tokens[first:index]
                if key in fields or len(value) != 1 or value[0][0] != "string" or not isinstance(value[0][1], str):
                    raise Unresolved("non-literal exec_command " + key)
                fields[key] = value[0][1]
            if index >= len(tokens):
                raise Unresolved("unterminated exec_command argument object")
            if tokens[index] == ("punct", ","):
                index += 1
        if tokens[index + 1:index + 2] != [("punct", ")")]:
            raise Unresolved("non-literal exec_command argument expression")
        if "cmd" not in fields:
            raise Unresolved("missing literal exec_command cmd")
        if len(result) >= 32:
            raise Unresolved("more than MAX_SCRIPTS (32) code-mode commands")
        result.append((fields["cmd"], fields.get("workdir") or fields.get("cwd") or fallback_cwd))
    return result
