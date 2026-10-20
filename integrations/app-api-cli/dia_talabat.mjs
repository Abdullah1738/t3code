// Last-resort Talabat restaurant search through Dia Personal (used automatically by
// talabat_native.py when native and public web search both fail). Prints raw vendor
// rows selected by restaurants(); no cookies or page content are emitted.
import { DiaTransport } from './lib/dia.mjs';

const [query, page = '1', lat, lng] = process.argv.slice(2);
let transport;
try {
  transport = await new DiaTransport({ timeout: 20000 }).init();
  const body = { latitude: Number(lat), longitude: Number(lng), query, vertical_ids: [0], limit: 100, country_id: 4, page_number: Number(page) - 1 };
  const handle = await transport.request('https://www.talabat.com', '/nextSearchApi/v3/vendor', { method: 'POST', headers: {
    'content-type': 'application/json', 'Accept-Language': 'en-US', 'X-Device-Source': '0', appBrand: '1', sourceApp: 'web',
  }, body });
  const result = await transport.project(handle, (d) => {
    if (!Array.isArray(d?.result?.vendors)) return { error: 'SCHEMA_CHANGED' };
    const keep = ['vendor_id', 'vendor_name', 'branch_name', 'chain_id', 'cuisines', 'rating', 'pickup_distance', 'vendor_status',
      'time_estimation', 'delivery_charges', 'is_sponsored', 'tags'];
    return { vendors: d.result.vendors.map(v => Object.fromEntries(keep.map(k => [k, k === 'tags' ? (v.tags || []).map(t => ({ label: t.label })) : v[k]]))),
      metadata: d.result.metadata };
  });
  console.log(JSON.stringify(result));
} catch (e) {
  console.log(JSON.stringify({ error: e.code || 'DIA_FAILED' }));
  process.exitCode = 1;
} finally { if (transport) await transport.close(); }
