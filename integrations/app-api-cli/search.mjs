import { DiaTransport, SearchError } from './lib/dia.mjs';
import { products, restaurants, menu, account } from './lib/project.mjs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
const execFileAsync = promisify(execFile);

const HOME = Object.freeze({ name: 'Banyan Tree Residences Hillside, Flat 2104, JLT', latitude: 25.0778251, longitude: 55.1569039, area_id: 1308, source: 'saved_home_pin_from_noon_account', saved_address_verified: false });
const ORIGINS = { noon: 'https://www.noon.com', minutes: 'https://minutes.noon.com', talabat: 'https://www.talabat.com' };
const HELP = `Read-only UAE shopping search. noon/Minutes: authenticated native API.
Talabat: native Android catalog (guest context); Dia Personal web fallback.

  noon-search "marvis" [--rocket]             supermall/marketplace (+ETA, Rocket ~1h)
  noon-search --minutes "smetana"              noon Minutes
  noon-search food "sushi" [--open]            noon Food restaurants + dishes
  noon-search food-menu OUTLETCODE [--query x] noon Food menu
  noon-search food-match "sushi" "seaweed salad" [--open]
  talabat-search "sushi" [--open] [--exact]    ranked, deduped, live status
  talabat-search menu 717327 [--query pizza] [--synonyms]
  talabat-search menu-match "sushi" "seaweed salad" --open
  talabat-search hours 717327
  talabat-search --mart "milk"
  talabat-search pharmacies "panadol" [--open] [--stores 12]
  talabat-search groceries "smetana" [--open]   (also: flowers)
  shop-search doctor
  noon-search orders [--minutes] --json
  noon-search track ORDER_ID --json
  talabat-search orders [--with-addresses --limit 3] | order ORDER_ID | track ORDER_ID
  talabat-search order-items ORDER_ID [--json]  (ordered lines + choices/notes, resolved to menu description and published macros)
  shop-search match APP SECTION "milk" "eggs" [--open]

Options: --limit 1..100 (menu default 1000), --page N (1-based), --timeout 5..60
         --open (live open-now filter), --raw (unranked Talabat search page)
         --web (force web), --native (never fall back)
         --require-account (fail unless account verified), --json, --help
         --images-dir DIR (download returned images for visual inspection)
Fallbacks are automatic and listed under "fallbacks" (FALLBACK lines in text).

Native noon uses the captured Android login and verifies saved Banyantree on every
call. Credentials stay in Keychain. Talabat/web fallback uses building coordinates
and unverified web account benefits. Orders use the existing phone skills.`;

function args(argv) {
  let mode = argv.shift();
  const o = { mode, json: false, limit: mode === 'menu' ? 1000 : 10, page: 1, timeout: 20, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--minutes') o.mode = 'minutes';
    else if (x === '--nownow' && mode === 'noon') o.mode = 'nownow';
    else if (x === '--mart' && mode === 'talabat') o.mode = 'mart';
    else if (x === '--json') o.json = true;
    else if (x === '--exact') o.exact = true;
    else if (x === '--require-account') o.requireAccount = true;
    else if (x === '--web') o.web = true;
    else if (x === '--native') o.native = true;
    else if (x === '--open') o.open = true;
    else if (x === '--raw') o.raw = true;
    else if (x === '--rocket') o.rocket = true;
    else if (x === '--synonyms') o.synonyms = true;
    else if (x === '--food' && mode === 'noon') o.mode = 'noon-food';
    else if (['--pharmacy', '--pharmacies', '--groceries', '--grocery', '--flowers'].includes(x) && mode === 'talabat') o.mode = { '--pharmacy': 'pharmacies', '--pharmacies': 'pharmacies', '--groceries': 'groceries', '--grocery': 'groceries', '--flowers': 'flowers' }[x];
    else if (x === '--help' || x === '-h') o.help = true;
    else if (['--limit', '--page', '--timeout', '--slug', '--query', '--stores', '--store', '--images-dir'].includes(x)) {
      const v = argv[++i];
      if (v === undefined) throw new SearchError('USAGE', `${x} needs a value.`);
      o[x.slice(2)] = ['--limit', '--page', '--timeout', '--stores'].includes(x) ? Number(v) : v;
    } else if (x.startsWith('-')) throw new SearchError('USAGE', `Unknown option: ${x}`);
    else o.positional.push(x);
  }
  if (o.mode === 'talabat' && ['menu', 'hours', 'mart', 'menu-match', 'groceries', 'pharmacies', 'flowers'].includes(o.positional[0])) {
    o.mode = o.positional.shift(); if (o.mode === 'menu' && !argv.includes('--limit')) o.limit = 1000;
  }
  if (['noon', 'noon-food'].includes(o.mode) && ['food', 'food-menu', 'menu', 'food-match', 'menu-match', 'minutes', 'supermall', 'rocket'].includes(o.positional[0])) {
    const sub = o.positional.shift();
    o.mode = { food: 'noon-food', 'food-menu': 'noon-food-menu', menu: 'noon-food-menu', 'food-match': 'noon-food-match', 'menu-match': 'noon-food-match', minutes: 'minutes', supermall: 'noon', rocket: 'noon' }[sub];
    if (sub === 'rocket') o.rocket = true;
    if (o.mode === 'noon-food-menu' && !argv.includes('--limit')) o.limit = 1000;
  }
  if (!Number.isInteger(o.limit) || o.limit < 1 || o.limit > (['menu', 'noon-food-menu'].includes(o.mode) ? 5000 : 100)) throw new SearchError('USAGE', 'Invalid --limit.');
  if (!Number.isInteger(o.page) || o.page < 1 || o.page > 100) throw new SearchError('USAGE', 'Invalid --page.');
  if (!Number.isFinite(o.timeout) || o.timeout < 5 || o.timeout > 60) throw new SearchError('USAGE', 'Invalid --timeout.');
  if (o.requireAccount && o.web && !['noon', 'minutes'].includes(o.mode)) throw new SearchError('LOGIN_REQUIRED', 'Talabat web account verification is unavailable. Use the logged-in phone app.');
  if (o.web && ['hours', 'mart', 'menu-match', 'groceries', 'pharmacies', 'flowers'].includes(o.mode) || o.web && o.mode.startsWith('noon-food')) throw new SearchError('WEB_UNSUPPORTED', 'This lookup is native-only. Use the phone workflow if native capture is unavailable.');
  if (o.web && o.native) throw new SearchError('USAGE', 'Choose --web or --native.');
  return o;
}

async function run(o, transport) {
  const base = { ok: true, source: 'dia_web_api', profile: 'Personal', fetched_at: new Date().toISOString(), location: HOME,
    account: { authenticated: null, scope: 'runtime_browser_session_not_android' } };
  if (o.mode === 'doctor') return { ...base, features: { noon: 'web_search', minutes: 'coordinate_scoped_web_search', talabat: 'coordinate_scoped_restaurant_search_and_web_menu', native_app_api: 'blocked_google_play_check' },
    browser: 'connected', auth: 'Cookies stay in Dia; no credentials exported or stored by this CLI.' };
  if (['noon', 'minutes'].includes(o.mode)) {
    const query = o.positional.join(' ').trim();
    if (!query) throw new SearchError('USAGE', 'Provide a product query.');
    const minutes = o.mode === 'minutes', origin = ORIGINS[o.mode];
    const headers = { 'x-locale': 'en-ae', 'x-platform': minutes ? 'mweb' : 'web', 'x-lat': String(Math.round(HOME.latitude * 1e7)), 'x-lng': String(Math.round(HOME.longitude * 1e7)) };
    if (minutes) Object.assign(headers, { 'x-mp': 'nooninstant', 'x-experience': 'nooninstant', 'x-cms': 'v2' });
    if (o.requireAccount) {
      base.account = { ...base.account, ...await transport.project(await transport.request(origin, '/_vs/st/st-whoami-api-web/whoami', { headers }), account) };
      if (!base.account.authenticated) throw new SearchError('LOGIN_REQUIRED', 'Log in to noon in Dia Personal, then retry. The CLI does not request or log OTPs.');
    }
    const qs = new URLSearchParams({ q: query, page: String(o.page), [minutes ? 'rows' : 'limit']: String(o.limit) });
    if (minutes) qs.set('productsOnly', '1');
    const path = minutes ? '/_svc/catalog/search' : '/_svc/catalog/api/v3/u/search';
    const result = await transport.project(await transport.request(origin, `${path}?${qs}`, { headers }), products, { minutes, limit: o.limit, page: o.page });
    if (result.error) throw new SearchError(result.error, 'The product API response format changed.');
    return { ...base, service: o.mode, ...result, query, notes: [
      'Account-specific discounts are not guaranteed. Delivery ETA is unavailable from this search response.',
      ...(minutes ? ['max_quantity is the per-order cap, not a warehouse stock count.'] : ['Banyantree coordinates are sent; marketplace delivery coverage is not verified by this response.']),
    ] };
  }
  if (o.mode === 'talabat') {
    const query = o.positional.join(' ').trim();
    if (!query) throw new SearchError('USAGE', 'Provide a restaurant query.');
    const body = { latitude: HOME.latitude, longitude: HOME.longitude, query, vertical_ids: [0], limit: o.limit, country_id: 4, page_number: o.page - 1 };
    const handle = await transport.request(ORIGINS.talabat, '/nextSearchApi/v3/vendor', { method: 'POST', headers: {
      'content-type': 'application/json', 'Accept-Language': 'en-US', 'X-Device-Source': '0', appBrand: '1', sourceApp: 'web',
    }, body });
    const result = await transport.project(handle, restaurants, { limit: o.limit, page: o.page, exact: o.exact, query });
    if (result.error) throw new SearchError(result.error, 'The restaurant search response format changed.');
    return { ...base, service: 'talabat', query, ...result, notes: ['Search can include recommendations; --exact filters names on the returned page. total/has_more describe the unfiltered API results. Fees do not include verified talabat pro benefits.'] };
  }
  if (o.mode === 'menu') {
    const branchId = Number(o.positional[0]);
    if (!Number.isSafeInteger(branchId) || branchId <= 0 || o.positional.length !== 1 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(o.slug || '')) throw new SearchError('USAGE', 'Use talabat-search menu ID --slug SLUG; take both from a restaurant search result URL.');
    const qs = new URLSearchParams({ aid: '1308', countrySlug: 'uae', vertical: 'restaurant', branchId: String(branchId), branchSlug: o.slug });
    let result = await transport.project(await transport.request(ORIGINS.talabat, `/_next/data/manifests/menu.json?${qs}`), menu, { query: o.query || '', limit: o.limit, branchId });
    if (result.error === 'MENU_REDIRECT') {
      // The SSR JSON route sometimes returns a redirect despite a valid public
      // menu. Read the same document's embedded menu data without navigating.
      const path = `/uae/restaurant/${branchId}/${o.slug}?aid=1308`;
      result = await transport.project(await transport.request(ORIGINS.talabat, path, { html: true }), menu, { query: o.query || '', limit: o.limit, branchId });
    }
    if (result.error) throw new SearchError(result.error, 'Could not read that branch menu. Use the phone menu search plan.');
    return { ...base, service: 'talabat-menu', query: o.query || '', ...result,
      notes: ['Menu listing is not a live stock guarantee. Use restaurant search for Banyantree ETA/status; web menu fees and coordinates can use a stale area cookie.'] };
  }
  throw new SearchError('USAGE', 'Choose noon, minutes, talabat, menu or doctor.');
}

function human(d) {
  if (!d.ok) return `${d.error.code}: ${d.error.message}`;
  if (d.native_credentials) return `Native Keychain entries: noon=${d.native_credentials.noon}, Minutes=${d.native_credentials.minutes}, Talabat=${d.native_credentials.talabat}.\nTalabat: native guest catalog; account login pending.`;
  const lines = [`${d.service} · ${d.location?.name || HOME.name} · ${(d.items || d.stores || []).length} result(s)`, d.source === 'native_android_api' ? (d.account.authenticated ? 'Authenticated Android session; saved Banyantree verified.' : 'Native guest catalog; account benefits and saved-home address not verified.') : 'Web session; saved-home/account benefits not verified.'];
  for (const f of d.fallbacks || []) lines.push(`FALLBACK ${f.step}: ${f.reason}`);
  if (d.stores) for (const s of d.stores) {
    lines.push(`${s.store}${s.area ? ` (${s.area})` : ''} | ${s.status || 'status unknown'}${s.status_description ? ` ${s.status_description}` : ''} | ${s.eta || 'ETA ?'} | fee AED ${s.delivery_fee ?? '?'} | ${s.item_subtotal != null ? `item subtotal AED ${s.item_subtotal}` : `from AED ${s.cheapest ?? '?'}`}`);
    for (const i of (s.items || Object.values(s.matches || {}).flat()).slice(0, 6)) lines.push(`    ${i.name} | AED ${i.price ?? '?'}${i.buyable === false ? ' | unavailable' : ''}`);
  }
  if (d.restaurant) lines.push(`${d.restaurant.name} | ${d.restaurant.status_description || 'Status unavailable'} | ${d.restaurant.eta || 'ETA unavailable'}`);
  if (d.warehouse) lines.push(`Warehouse: ${d.warehouse}`);
  for (const p of d.items || []) {
    if (p.matches) lines.push(`${p.id}  ${p.name}${p.area ? ` (${p.area})` : ''} | ${p.status} | ${p.eta || 'ETA ?'} | fee AED ${p.delivery_fee ?? '?'} | ${p.rating ?? '-'}★\n  ` + Object.entries(p.matches).map(([t, xs]) => `${t}: ${xs[0].name} AED ${xs[0].price}`).join(' · '));
    else if ('delivery_fee' in p) lines.push(`${p.id}  ${p.name}${p.area ? ` (${p.area})` : ''} | ${p.status || ''}${p.status_description ? ` ${p.status_description}` : ''} | ${p.eta || 'ETA unknown'} | delivery AED ${p.delivery_fee ?? '?'}${p.rating ? ` | ${p.rating}★` : ''}${p.url ? `\n  ${p.url}` : ''}`);
    else lines.push(`${p.id}  ${p.name}${p.size ? ` · ${p.size}` : ''} | AED ${p.price ?? '?'}${p.eta ? ` | ${p.eta}` : ''}${p.rocket_eta ? ` | Rocket ${p.rocket_eta}` : ''}${'buyable' in p ? ` | ${p.buyable === true ? 'buyable' : p.buyable === false ? 'unavailable' : 'availability unknown'}` : ''}${p.max_quantity !== undefined && p.max_quantity !== null ? ` | max/order ${p.max_quantity}` : ''}${p.category ? ` | ${p.category}` : ''}${p.description ? `\n  ${p.description}` : ''}`);
  }
  if (!(d.items || d.stores || []).length && d.service !== 'talabat-hours') lines.push('No matching results.');
  return lines.join('\n');
}

let transport;
const started = performance.now();
const rawArgs = process.argv.slice(2);
let json = rawArgs.includes('--json');
try {
  if (rawArgs[0] === 'talabat' && rawArgs[1] === 'order') rawArgs[1] = 'track';
  if (['noon', 'talabat'].includes(rawArgs[0]) && ['orders', 'track'].includes(rawArgs[1])) {
    const child = spawn(`${homedir()}/.local/share/uv/tools/mitmproxy/bin/python`,
      [fileURLToPath(new URL('./native_orders.py', import.meta.url)), ...rawArgs], { stdio: 'inherit' });
    child.on('error', () => process.exit(1));
    child.on('exit', code => process.exit(code ?? 1));
    await new Promise(resolve => child.on('close', resolve));
    process.exit(1);
  }
  if (rawArgs[0] === 'talabat' && rawArgs[1] === 'order-items') {
    const child = spawn(`${homedir()}/.local/share/uv/tools/mitmproxy/bin/python`,
      [fileURLToPath(new URL('./talabat_order_items.py', import.meta.url)), ...rawArgs.slice(2)], { stdio: 'inherit' });
    child.on('error', () => process.exit(1));
    child.on('exit', code => process.exit(code ?? 1));
    await new Promise(resolve => child.on('close', resolve));
    process.exit(1);
  }
  if (!rawArgs.length || rawArgs.includes('--help') || rawArgs.includes('-h')) { console.log(HELP); process.exit(0); }
  const o = args(rawArgs); json = o.json;
  if (['noon','minutes','nownow','noon-food'].includes(o.mode) && !o.positional.join(' ').trim()) throw new SearchError('USAGE','Provide a nonempty search query.');
  let data;
  if (o.mode === 'nownow' || o.mode === 'noon' && o.positional[0] === 'nownow') {
    if (o.positional[0] === 'nownow') o.positional.shift();
    if (o.web) throw new SearchError('UNSUPPORTED_OPTION', 'NowNow uses its authenticated native catalog; web mode is unavailable.');
    let output;
    try { output = await execFileAsync(`${homedir()}/.local/share/uv/tools/mitmproxy/bin/python`, [fileURLToPath(new URL('./nownow_native.py', import.meta.url)), o.positional.join(' '), '--limit', String(o.limit), '--page', String(o.page), '--timeout', String(o.timeout), ...(o.open ? ['--open'] : [])], {timeout:100000,maxBuffer:8*1024*1024}); }
    catch(e) { if(e.stdout) output=e; else throw new SearchError('NATIVE_TRANSPORT_FAILED','NowNow native search timed out.'); }
    data=JSON.parse(output.stdout);
    if(!data.ok) throw new SearchError(data.error.code,`${data.error.message}${data.error.exception_type ? ` (${data.error.exception_type})` : ''}`);
  } else if (o.mode === 'match') {
    let output;
    try { output = await execFileAsync(`${homedir()}/.local/share/uv/tools/mitmproxy/bin/python`,
      [fileURLToPath(new URL('./basket.py', import.meta.url)), ...o.positional,
       '--limit', String(o.limit), '--timeout', String(o.timeout), ...(o.open ? ['--open'] : [])],
      { timeout: 360000, maxBuffer: 16 * 1024 * 1024 }); }
    catch(e) { if(e.stdout) output=e; else throw new SearchError('BASKET_SEARCH_FAILED','Component search timed out.'); }
    data = JSON.parse(output.stdout);
    if(!data.ok) throw new SearchError(data.error,data.message);
  } else
  if (o.mode === 'doctor' || (['noon', 'minutes', 'noon-food', 'noon-food-menu', 'noon-food-match'].includes(o.mode) && !o.web)) {
    const python = `${homedir()}/.local/share/uv/tools/mitmproxy/bin/python`;
    const nmode = { noon: 'noon', minutes: 'minutes', doctor: 'doctor', 'noon-food': 'food', 'noon-food-menu': 'food-menu', 'noon-food-match': 'food-match' }[o.mode];
    let output;
    try {
      output = await execFileAsync(python, [fileURLToPath(new URL('./native.py', import.meta.url)), nmode,
        ...(o.mode === 'doctor' ? [] : [...(o.mode === 'noon-food-match' ? o.positional : [o.positional.join(' ')]), '--limit', String(o.limit), '--page', String(o.page), '--timeout', String(o.timeout),
          ...(o.open ? ['--open'] : []), ...(o.rocket ? ['--rocket'] : []), ...(o.query ? ['--query', o.query] : [])])],
        { timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    } catch (e) {
      if (e.stdout) output = e;
      else throw new SearchError('NATIVE_TRANSPORT_FAILED', 'Native transport timed out or could not start. No guest fallback was used.');
    }
    data = JSON.parse(output.stdout);
    if (!data.ok) {
      // Automatic, announced fallback for product search only. Account-only
      // codes (AUTH_EXPIRED/HOME_MISMATCH) still surface so recapture is visible.
      if (['noon', 'minutes'].includes(o.mode) && !o.native && !o.requireAccount) {
        const reason = `native ${data.error.code}`;
        transport = await new DiaTransport({ timeout: o.timeout * 1000 }).init();
        data = await run(o, transport);
        data.fallbacks = [{ step: 'product_search', reason: `${reason}; used Dia Personal web search (guest prices, no saved-home check)` }];
      } else throw new SearchError(data.error.code, data.error.message);
    }
  } else if (['talabat', 'menu', 'hours', 'mart', 'menu-match', 'groceries', 'pharmacies', 'flowers'].includes(o.mode) && (!o.web || o.mode === 'talabat')) {
    const mode = o.mode === 'talabat' ? 'restaurants' : o.mode;
    const branchMode = ['menu', 'hours'].includes(mode);
    const branch = Number(o.positional[0]);
    if (branchMode && (!Number.isSafeInteger(branch) || branch <= 0 || o.positional.length !== 1)) throw new SearchError('USAGE', 'Provide one positive restaurant branch ID.');
    let output;
    try {
      output = await execFileAsync(`${homedir()}/.local/share/uv/tools/mitmproxy/bin/python`, [fileURLToPath(new URL('./talabat_native.py', import.meta.url)), mode,
        ...(branchMode ? [o.query || ''] : mode === 'menu-match' ? o.positional : [o.positional.join(' ')]), ...(branchMode ? ['--branch', String(branch)] : []),
        '--limit', String(o.limit), '--page', String(o.page), '--timeout', String(o.timeout),
        ...(o.stores ? ['--stores', String(o.stores)] : []),
        ...(o.store ? ['--store', o.store] : []),
        ...(o.exact ? ['--exact'] : []), ...(o.open ? ['--open'] : []), ...(o.raw ? ['--raw'] : []), ...(o.synonyms ? ['--synonyms'] : []),
        ...(o.native ? ['--native'] : []), ...(o.web ? ['--web'] : []),
        ...(o.requireAccount ? ['--require-account'] : [])],
        { timeout: 170000, maxBuffer: 16 * 1024 * 1024 });
    } catch (e) {
      if (e.stdout) output = e;
      else throw new SearchError('NATIVE_TRANSPORT_FAILED', 'Native Talabat transport could not start or timed out. Use --web for restaurant/menu fallback.');
    }
    data = JSON.parse(output.stdout);
    if (!data.ok) {
      if (['talabat', 'menu'].includes(o.mode) && !o.open && !o.native && !o.requireAccount && data.error.code !== 'USAGE' && (o.mode !== 'menu' || o.slug)) {
        const reason = `native ${data.error.code}`;
        transport = await new DiaTransport({ timeout: o.timeout * 1000 }).init();
        data = await run(o, transport);
        data.fallbacks = [{ step: o.mode, reason: `${reason}; used Dia Personal web (status flag from web is unreliable)` }];
      } else throw new SearchError(data.error.code, data.error.message);
    }
  } else {
    transport = await new DiaTransport({ timeout: o.timeout * 1000 }).init();
    data = await run(o, transport);
  }
  data.elapsed_ms = Math.round(performance.now() - started);
  data = await new Promise((resolve, reject) => {
    const child = spawn(`${homedir()}/.local/share/uv/tools/mitmproxy/bin/python`,
      [fileURLToPath(new URL('./catalog_schema.py', import.meta.url)), ...(o['images-dir'] ? [o['images-dir']] : [])]);
    let output = '';
    child.stdout.on('data', chunk => output += chunk);
    child.on('error', reject);
    child.on('close', code => { try { code === 0 ? resolve(JSON.parse(output)) : reject(new Error('Image presentation failed')); } catch(e) { reject(e); } });
    child.stdin.end(JSON.stringify(data));
  });
  function imageLines(v) {
    if (Array.isArray(v)) return v.flatMap(imageLines);
    if (!v || typeof v !== 'object') return [];
    return [...(v.image_url ? [`${v.name || 'Item'} image_url: ${v.image_url}${v.image_path ? `\n  image_path: ${v.image_path}` : ''}`] : []), ...Object.values(v).flatMap(imageLines)];
  }
  console.log(json ? JSON.stringify(data, null, 2) : [human(data), ...imageLines(data)].join('\n'));
} catch (e) {
  const data = { ok: false, error: { code: e instanceof SearchError ? e.code : 'TRANSPORT_FAILED', message: e instanceof SearchError ? e.message : 'Dia search transport failed or timed out. Retry once, then use the phone search plan.' } };
  console.log(json ? JSON.stringify(data, null, 2) : human(data));
  process.exitCode = e.code === 'USAGE' ? 2 : 1;
} finally { if (transport) await transport.close(); }
