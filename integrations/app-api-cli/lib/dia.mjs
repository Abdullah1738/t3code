import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const bridge = pathToFileURL(`${homedir()}/.config/opencode/dia-agent-bridge/src/`);
const cdp = await import(new URL('cdp.js', bridge));
const dia = await import(new URL('dia.js', bridge));

export class SearchError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Exact endpoint allowlist: a caller cannot turn this into a generic account client.
export function allowedRequest(origin, path, method) {
  const url = new URL(path, origin);
  if (url.origin !== origin || url.username || url.password) return false;
  const p = url.pathname;
  if (origin === 'https://www.noon.com') return method === 'GET' && [
    '/_svc/catalog/api/v3/u/search', '/_vs/st/st-whoami-api-web/whoami',
  ].includes(p);
  if (origin === 'https://minutes.noon.com') return method === 'GET' && [
    '/_svc/catalog/search', '/_vs/st/st-whoami-api-web/whoami',
  ].includes(p);
  if (origin === 'https://www.talabat.com') return (
    (method === 'POST' && p === '/nextSearchApi/v3/vendor') ||
    (method === 'GET' && p === '/_next/data/manifests/menu.json') ||
    (method === 'GET' && /^\/uae\/restaurant\/\d+\/[a-z0-9-]+\/?$/.test(p))
  );
  return false;
}

export class DiaTransport {
  constructor({ timeout = 20000 } = {}) { this.timeout = timeout; this.pages = new Map(); }

  async init() {
    let inventory, targets;
    try { [inventory, targets] = await Promise.all([dia.getDiaInventory(), cdp.getBrowserTargets()]); }
    catch { throw new SearchError('DIA_UNAVAILABLE', 'Open Dia with the Personal profile and its configured CDP bridge, then retry.'); }
    const profiles = cdp.resolveProfileContexts(inventory, targets).filter(x => x.profile === 'Personal');
    if (profiles.length !== 1 || profiles[0].mappingStatus !== 'mapped') {
      throw new SearchError('PROFILE_UNRESOLVED', 'Dia Personal could not be uniquely mapped. Open a normal tab in Personal and retry.');
    }
    this.context = profiles[0].browserContextId;
    this.targets = targets;
    return this;
  }

  async page(origin) {
    if (this.pages.has(origin)) return this.pages.get(origin);
    // Reuse a matching page without navigating or changing the native active tab.
    let target = this.targets.find(t => t.type === 'page' &&
      (t.browserContextId || 'default') === this.context && t.url.startsWith(`${origin}/`));
    let created = false;
    if (!target) {
      const { targetId } = await cdp.createTarget({ browserContextId: this.context, url: `${origin}/${origin.includes('talabat') ? 'uae' : 'uae-en/'}` });
      created = true;
      for (let i = 0; i < 20 && !target; i++) {
        target = (await cdp.getBrowserTargets()).find(x => x.targetId === targetId);
        if (!target) await delay(100);
      }
      if (!target) throw new SearchError('TAB_UNAVAILABLE', 'Could not create the background search tab.');
    }
    const socket = await cdp.openSocket(target.webSocketDebuggerUrl, 'shop-search Dia page');
    const page = { socket, target, created, origin };
    this.pages.set(origin, page);
    // Keep this CDP connection alive for the whole operation. Dia suspends hidden
    // pages otherwise, including fetch promises and AbortSignal timers.
    await cdp.cdpCall(socket, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp.cdpCall(socket, 'Page.setWebLifecycleState', { state: 'active' });
    const deadline = Date.now() + this.timeout;
    while (Date.now() < deadline) {
      try {
        const state = await this.evaluate(page, '({origin:location.origin,ready:document.readyState})');
        if (state.origin === origin && state.ready !== 'loading') return page;
      } catch { /* Page is navigating. */ }
      await delay(100);
    }
    throw new SearchError('TAB_TIMEOUT', 'The background shop page did not finish loading.');
  }

  async evaluate(page, expression, awaitPromise = true) {
    const r = await cdp.cdpCall(page.socket, 'Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true, userGesture: true,
    }, this.timeout + 2000);
    if (r.exceptionDetails) throw new SearchError('PAGE_EVALUATION', 'Search failed in the Dia page. No page content was logged.');
    return r.result?.value;
  }

  async request(origin, path, { method = 'GET', headers = {}, body, html = false } = {}) {
    if (!allowedRequest(origin, path, method)) throw new SearchError('ENDPOINT_DENIED', 'Only the verified read-only search endpoints are allowed.');
    const page = await this.page(origin);
    const key = `__shop_${randomUUID().replaceAll('-', '')}`;
    const spec = { origin, path, method, headers, body, html, timeout: this.timeout };
    // Raw replies remain in page memory until taken, then are deleted. They are
    // never written to disk or printed. Cookies stay in Dia's native cookie jar.
    const result = await this.evaluate(page, `(async()=>{
      const s=${JSON.stringify(spec)};
      if(location.origin!==s.origin)return {error:'ORIGIN_CHANGED'};
      const c=new AbortController(); const timer=setTimeout(()=>c.abort(),s.timeout);
      try {
        const r=await fetch(s.path,{method:s.method,headers:s.headers,
          body:s.body===undefined?undefined:JSON.stringify(s.body),credentials:'include',
          redirect:'error',signal:c.signal,cache:'no-store'});
        if(!r.ok)return {status:r.status};
        let d;
        if(s.html){
          const doc=new DOMParser().parseFromString(await r.text(),'text/html');
          const el=doc.getElementById('__NEXT_DATA__');
          if(!el)return {error:'SCHEMA_CHANGED'};
          d=JSON.parse(el.textContent).props;
        }else{try{d=await r.json()}catch{return {error:'NOT_JSON'}}}
        window[${JSON.stringify(key)}]=d;return {status:r.status};
      }catch(e){return {error:e.name==='AbortError'?'HTTP_TIMEOUT':'HTTP_FAILED'}}
      finally{clearTimeout(timer)}
    })()`);
    if (result?.error) throw new SearchError(result.error, 'Search request failed. Retry once; use the phone search plan if it persists.');
    if (result?.status !== 200) throw new SearchError(`HTTP_${result?.status ?? 'UNKNOWN'}`, `Search endpoint returned HTTP ${result?.status ?? 'unknown'}. Open the site in Dia Personal if it needs a login or browser check.`);
    return { page, key };
  }

  async project(handle, fn, args = {}) {
    return this.evaluate(handle.page, `(()=>{const k=${JSON.stringify(handle.key)};const d=window[k];delete window[k];return (${fn.toString()})(d,${JSON.stringify(args)})})()`);
  }

  async close() {
    for (const { socket, target, created } of this.pages.values()) {
      try { await cdp.cdpCall(socket, 'Emulation.setFocusEmulationEnabled', { enabled: false }, 2000); } catch {}
      socket.close();
      if (created) { try { await cdp.closeTarget(target.targetId); } catch {} }
    }
  }
}
