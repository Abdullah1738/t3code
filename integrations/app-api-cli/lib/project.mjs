// These functions execute inside Dia; keep them self-contained. Explicit field
// selection prevents response auth/ad tokens from escaping into JSON output.
export function products(d, { minutes, limit, page }) {
  if (!Array.isArray(d?.hits)) return { error: 'SCHEMA_CHANGED' };
  const rows = d.hits.slice(0, limit).map(p => ({
    id: p.sku,
    name: [p.brand, p.title || p.name].filter(Boolean).join(' '),
    size: p.sizeInfo ?? p.size_info ?? null,
    image_url: p.image_url ?? p.imageUrl ?? ((p.imageKey || p.image_key) ? `https://f.nooncdn.com/p/${p.imageKey || p.image_key}.jpg` : null),
    price: p.offerPrice ?? p.offer_price ?? p.salePrice ?? p.sale_price ?? p.price ?? null,
    regular_price: p.price ?? null,
    currency: 'AED',
    buyable: p.isBuyable ?? p.is_buyable ?? null,
    max_quantity: p.maxQty ?? p.max_qty ?? null,
    unavailable_reason: p.notBuyableReason ?? p.not_buyable_reason ?? null,
    seller: p.store_name ?? null,
    rating: p.product_rating?.value ?? null,
    eta: null,
    url: minutes ? `https://minutes.noon.com/uae-en/search/?q=${encodeURIComponent(p.sku)}` :
      `https://www.noon.com/uae-en/${encodeURIComponent(p.url || 'product')}/${encodeURIComponent(p.sku)}/p/`,
  }));
  return { items: rows, total: d.nbHits ?? null, pages: d.nbPages ?? null, page,
    warehouse: d.whCode ?? null, query: d.search?.q ?? null };
}

export function restaurants(d, { limit, page, exact, query }) {
  if (d?.hasserror || !Array.isArray(d?.result?.vendors)) return { error: 'SCHEMA_CHANGED' };
  let list = d.result.vendors;
  if (exact) list = list.filter(v => v.vendor_name?.toLowerCase().includes(query.toLowerCase()));
  return {
    items: list.slice(0, limit).map(v => ({
      id: v.vendor_id, name: v.vendor_name, branch: v.branch_name ?? null,
      image_url: v.vendor_image ? (v.vendor_image.startsWith('https://') ? v.vendor_image : `https://talabat.dhmedia.io/image/talabat/Restaurants/${v.vendor_image}`) : null,
      cuisine: v.cuisines?.map(c => c.na).filter(Boolean).join(', ') || null,
      rating: v.rating ?? null, delivery_fee: v.delivery_charges ?? null, currency: 'AED',
      eta: v.time_estimation ?? null, status_code: v.vendor_status ?? null,
      exact_match: v.exact_match ?? null, delivery_text: v.delivery_text ?? null,
      url: `https://www.talabat.com/uae/restaurant/${v.vendor_id}/${v.vendor_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}?aid=1308`,
    })),
    total: d.result.metadata?.counts?.total ?? null,
    has_more: d.result.metadata?.pagination?.has_more_pages ?? null,
    page,
  };
}

export function menu(d, { query, limit, branchId }) {
  const s = d?.pageProps?.initialMenuState;
  if (!s) return { error: d?.pageProps?.__N_REDIRECT ? 'MENU_REDIRECT' : 'SCHEMA_CHANGED' };
  if (Number(s.restaurant?.branchId) !== branchId) return { error: 'BRANCH_MISMATCH' };
  const all = s.menuData?.categories?.flatMap(c => (c.items || []).map(x => ({ ...x, category: c.name }))) || s.menuData?.items;
  if (!Array.isArray(all)) return { error: 'SCHEMA_CHANGED' };
  const seen = new Set();
  const unique = all.filter(x => { if (seen.has(x.id)) return false; seen.add(x.id); return true; });
  const matches = unique.filter(x => !query || `${x.name} ${x.description || ''}`.toLowerCase().includes(query.toLowerCase()));
  return { restaurant: { id: s.restaurant.branchId, name: s.restaurant.name },
    area: { id: s.area?.id ?? null, name: s.area?.name ?? null },
    total_menu_items: unique.length, matching_items: matches.length,
    items: matches.slice(0, limit).map(x => ({
      id: x.id, name: x.name, description: x.description || '', category: x.category ?? x.originalSection ?? x.sectionName ?? null,
      price: x.price ?? null, regular_price: x.oldPrice > 0 ? x.oldPrice : null,
      image_url: x.imageUrl ?? x.image ?? null,
      currency: 'AED', has_options: x.hasChoices ?? null,
      availability: 'listed_on_web_menu',
    })),
  };
}

export function account(d) {
  return { authenticated: Boolean(d?.customer?.customerCode) };
}
