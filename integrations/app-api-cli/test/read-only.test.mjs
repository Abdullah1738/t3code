import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedRequest } from '../lib/dia.mjs';
import { products, restaurants, menu } from '../lib/project.mjs';

test('transport cannot reach ordering, auth mutation, arbitrary hosts or redirected origins', () => {
  for (const origin of ['https://www.noon.com', 'https://minutes.noon.com', 'https://www.talabat.com']) {
    for (const p of ['/_svc/instant/order/place', '/_svc/instant/session/sync', '/nextPayApi/pay', '/nextCheckoutApi/cart', 'https://example.com/steal', '//example.com/steal', '/_svc/mp-identity-api/address/set-default']) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) assert.equal(allowedRequest(origin, p, method), false);
    }
  }
  assert.equal(allowedRequest('https://www.talabat.com', '/nextSearchApi/v3/vendor', 'POST'), true);
  assert.equal(allowedRequest('https://minutes.noon.com', '/_svc/catalog/search?q=milk', 'GET'), true);
  assert.equal(allowedRequest('https://minutes.noon.com', '/_svc/catalog/search?q=milk', 'POST'), false);
});

test('projections discard credentials/ad tokens and preserve unknown availability', () => {
  const fixtureSecret = 'fixture-secret-never-print';
  const p = products({ token: fixtureSecret, hits: [{ sku: 'X', name: 'Example', price: 10, is_buyable: false, cookie: fixtureSecret, pdp_url: `/?token=${fixtureSecret}` }] }, { minutes: false, limit: 3, page: 1 });
  const r = restaurants({ result: { vendors: [{ vendor_id: 12, vendor_name: 'Cafe', sponsored: { token: fixtureSecret } }] } }, { limit: 3, page: 1 });
  assert.equal(JSON.stringify([p, r]).includes(fixtureSecret), false);
  assert.equal(p.items[0].buyable, false);
  assert.equal(r.items[0].status_code, null);
  assert.equal(p.items[0].eta, null);
});

test('menu checks branch identity, deduplicates repeated promotions and filters descriptions', () => {
  const d = { pageProps: { initialMenuState: { restaurant: { branchId: 12, name: 'Cafe' }, menuData: { categories: [
    { name: 'Offers', items: [{ id: 1, name: 'Bowl', description: 'Protein 40g', price: 20 }] },
    { name: 'Main', items: [{ id: 1, name: 'Bowl', description: 'Protein 40g', price: 20 }, { id: 2, name: 'Water', price: 0 }] },
  ] } } } };
  const result = menu(d, { branchId: 12, query: 'protein', limit: 10 });
  assert.equal(result.total_menu_items, 2);
  assert.equal(result.matching_items, 1);
  assert.equal(result.items[0].availability, 'listed_on_web_menu');
  assert.equal(menu(d, { branchId: 13, query: '', limit: 10 }).error, 'BRANCH_MISMATCH');
  assert.equal(menu({ pageProps: { __N_REDIRECT: '/uae' } }, { branchId: 12 }).error, 'MENU_REDIRECT');
});
