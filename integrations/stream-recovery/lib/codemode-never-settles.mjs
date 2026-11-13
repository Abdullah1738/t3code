// Kept byte-identical in opencode-plugins/lib and stream-recovery/lib: the
// plugin and watcher deploy independently and must not import each other's install.
const identifier = /^[A-Za-z_$][\w$]*$/;

function tokens(code) {
  const out = [];
  const lex = /\s+|\/\/[^\n\r]*|\/\*[\s\S]*?\*\/|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`|[A-Za-z_$][\w$]*|=>|[^\s]/gy;
  let match;
  while ((match = lex.exec(code))) {
    const t = match[0];
    if (/^\s|^\/\//.test(t) || t.startsWith('/*')) continue;
    if (t[0] === "'" || t[0] === '"') { out.push('<string>'); continue; }
    if (t[0] === '`') { out.push('<template>'); continue; }
    // A regexp literal can contain fake constructors. Skip its text, including
    // character classes; uncertain slash contexts are left to the 20 min bound.
    if (t === '/') {
      // After e.g. `if (...)` or a block, slash can start a regexp or divide.
      // Without a full parser, skip the call rather than scan regexp text as JS.
      if (out.length && !/^(?:[=(:,!&|?;{\[]|return|throw|=>)$/.test(out.at(-1))) return null;
      let cls = false;
      let i = lex.lastIndex;
      for (; i < code.length; i++) {
        if (code[i] === '\\') { i++; continue; }
        if (code[i] === '[') cls = true;
        if (code[i] === ']') cls = false;
        if (code[i] === '/' && !cls) break;
      }
      lex.lastIndex = Math.min(i + 1, code.length);
      out.push('<regexp>');
      continue;
    }
    out.push(t);
  }
  return out;
}

function endGroup(ts, start) {
  const stack = [];
  const close = { '(': ')', '[': ']', '{': '}' };
  for (let i = start; i < ts.length; i++) {
    const t = ts[i];
    if (Object.hasOwn(close, t)) stack.push(close[t]);
    else if (t === ')' || t === ']' || t === '}') {
      if (stack.pop() !== t) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

export function neverSettles(code) {
  if (typeof code !== 'string') return false;
  const ts = tokens(code);
  if (!ts) return false;
  for (let i = 0; i < ts.length; i++) {
    if (ts[i] !== 'new' || ts[i + 1] !== 'Promise' || ts[i + 2] !== '(') continue;
    const end = endGroup(ts, i + 2);
    if (end < 0) continue;
    let at = i + 3;
    const fn = ts[at] === 'function';
    if (fn) {
      at++;
      if (identifier.test(ts[at] ?? '') && ts[at + 1] === '(') at++;
    }
    let params;
    if (ts[at] === '(') {
      const paramEnd = endGroup(ts, at);
      if (paramEnd < 0) continue;
      params = ts.slice(at + 1, paramEnd);
      at = paramEnd + 1;
    } else if (!fn && identifier.test(ts[at] ?? '')) params = [ts[at++]];
    else continue;
    // Destructuring, defaults, async executors and other uncertain forms are
    // not proof of a hang. Only simple resolver names are classified here.
    if (params.at(-1) === ',') params.pop();
    if (params.some((p, n) => n % 2 ? p !== ',' : !identifier.test(p)) || (params.length && params.length % 2 === 0)) continue;
    params = params.filter(p => p !== ',');
    if (!fn && ts[at++] !== '=>') continue;
    let body;
    if (ts[at] === '{') {
      const bodyEnd = endGroup(ts, at);
      if (bodyEnd < 0 || bodyEnd >= end) continue;
      body = ts.slice(at + 1, bodyEnd);
    } else if (!fn) body = ts.slice(at, end);
    else continue;
    // `arguments` can access the callbacks without naming the parameters.
    // Throws reject; templates can call a resolver inside opaque interpolation.
    if (body.includes('arguments') || body.includes('throw') || body.includes('<template>')) continue;
    let bare = body;
    while (bare.at(-1) === ';') bare = bare.slice(0, -1);
    if (bare[0] === 'return') bare = bare.slice(1);
    while (bare[0] === '(' && endGroup(bare, 0) === bare.length - 1) bare = bare.slice(1, -1);
    if (!bare.length || (bare.length === 1 && params.includes(bare[0])) ||
        !body.some(t => params.includes(t))) return true;
  }
  return false;
}
