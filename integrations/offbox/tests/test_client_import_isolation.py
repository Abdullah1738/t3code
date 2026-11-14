"""Keep same-named client and server test modules out of each other's import paths."""
import ast
from pathlib import Path
import unittest


def _path(node, paths):
    if isinstance(node, ast.Name):
        return paths.get(node.id)
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return Path(node.value)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
        left, right = _path(node.left, paths), _path(node.right, paths)
        return left / right if left is not None and right is not None else None
    if isinstance(node, ast.Call):
        if isinstance(node.func, ast.Name) and node.func.id == 'str' and node.args:
            return _path(node.args[0], paths)
        if isinstance(node.func, ast.Attribute) and node.func.attr == 'resolve':
            return _path(node.func.value, paths)
        if isinstance(node.func, ast.Attribute) and node.func.attr == 'joinpath':
            base, parts = _path(node.func.value, paths), [_path(n, paths) for n in node.args]
            return base.joinpath(*parts) if base is not None and None not in parts else None
        if ast.unparse(node.func) in {'Path', 'os.path.join'}:
            parts = [_path(n, paths) for n in node.args]
            return Path(*parts) if parts and None not in parts else None
    if isinstance(node, ast.Attribute) and node.attr == 'parent':
        value = _path(node.value, paths)
        return value.parent if value is not None else None
    if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Attribute):
        value = _path(node.value.value, paths)
        if node.value.attr == 'parents' and isinstance(node.slice, ast.Constant) and value is not None:
            return value.parents[node.slice.value]
    return None


class ClientImportIsolation(unittest.TestCase):
    def test_test_directories_are_isolated(self):
        server = Path(__file__).resolve().parent
        client = server.parent / 'skill' / 'scripts' / 'tests'
        stems = {folder: {p.stem for p in folder.glob('*.py')} for folder in (server, client)}
        violations = []
        for folder, forbidden in ((server, client), (client, server)):
            for file in sorted(folder.glob('*.py')):
                if file == Path(__file__).resolve() or file == server / 'client_fixtures.py':
                    continue
                paths, fallbacks = {'__file__': file}, set()
                nodes = ast.walk(ast.parse(file.read_text(), filename=str(file)))
                for node in sorted(nodes, key=lambda n: (getattr(n, 'lineno', 0), getattr(n, 'col_offset', 0))):
                    reason = None
                    if isinstance(node, (ast.Assign, ast.AnnAssign)) and node.value is not None:
                        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                        for target in targets:
                            if isinstance(target, ast.Name):
                                paths[target.id] = _path(node.value, paths)
                    if folder == server and isinstance(node, ast.If) and ast.unparse(node.test) == '__package__':
                        relative = {n.module for n in node.body if isinstance(n, ast.ImportFrom) and n.level == 1}
                        fallbacks.update(n for n in node.orelse if isinstance(n, ast.ImportFrom)
                                         and n.level == 0 and n.module in relative and n.module in stems[server])
                    if isinstance(node, ast.Call) and ast.unparse(node.func) in {'sys.path.insert', 'sys.path.append'}:
                        value = _path(node.args[-1], paths) if node.args else None
                        text = value.as_posix() if value is not None else ast.unparse(node)
                        if (value is not None and value.resolve() == forbidden
                                or 'scripts/tests' in text and folder == server
                                or 'integrations/offbox/tests' in text and folder == client):
                            reason = f'adds {forbidden.relative_to(server.parent)} to sys.path'
                    if isinstance(node, (ast.Import, ast.ImportFrom)):
                        names = ([n.name.split('.')[0] for n in node.names] if isinstance(node, ast.Import)
                                 else [node.module.split('.')[0]] if node.level == 0 and node.module else [])
                        banned = stems[server] | stems[client] if folder == server else stems[server] - stems[client]
                        if banned.intersection(names) and node not in fallbacks:
                            reason = 'bare test/fixture import outside a package fallback'
                    if reason:
                        violations.append(f'{file.relative_to(server.parent)}:{node.lineno}: {reason}')
        self.assertEqual(violations, [], '\n'.join(violations))
