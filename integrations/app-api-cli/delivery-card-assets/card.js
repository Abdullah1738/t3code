(() => {
  let data = JSON.parse(document.getElementById('initial').textContent);
  let signature = JSON.stringify(data);
  let offline = false;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = n => Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
  const main = document.querySelector('main');
  function freshness() {
    const el = document.getElementById('freshness');
    if (data.sample) { el.textContent = 'Sample order'; return; }
    const t = Date.parse(data.checked_at);
    const minutes = Math.max(0, Math.floor((Date.now() - t) / 60000));
    el.textContent = offline ? 'Connection unavailable' : data.terminal ? 'Final update' : data.unavailable ? 'Tracking delayed' : minutes >= 5 ? 'Tracking may be stale' : 'Latest tracking check';
    const time = document.createElement('time');
    time.dateTime = data.checked_at || '';
    time.textContent = Number.isFinite(t) ? (minutes < 1 ? 'Just now' : minutes + ' min ago') : 'No check received';
    el.append(time);
    if (!data.terminal && data.eta && Date.parse(data.eta) < Date.now()) {
      document.querySelector('.when').textContent = 'Estimate passed · checking';
    }
  }
  function render(v) {
    data = v;
    const steps = v.steps.map((s,i) => `<li class="${i<=v.index?'on':''}" ${i===v.index?'aria-current="step"':''}>${escape(s)}</li>`).join('');
    const rows = v.items.map(i => {const line=i.line_total??(i.price!==null?i.price*i.qty:null);return `<li class="${i.image?'has-photo':''}">${i.image?`<img src="${escape(i.image)}" alt="" width="56" height="56" loading="lazy" referrerpolicy="no-referrer">`:''}<span class="name">${escape(i.name)}<span class="qty"> ×${i.qty}</span></span>${line!==null?`<span class="price">${money(line)}</span>`:''}</li>`;}).join('');
    const focused = document.activeElement?.id === 'refresh';
    main.innerHTML = `<header class="eta"><div class="store">${escape(v.brand)}<span>${escape(v.store)}</span><span class="order">${escape(v.order)}</span></div><h1 class="${v.terminal?'word':''}">${escape(v.big)}</h1><p class="when">${escape(v.sub)}</p></header><section aria-label="Delivery progress"><p class="status" role="status">${escape(v.stage)}</p>${v.stage==='Cancelled'?'':`<ol class="steps" style="--steps:${v.steps.length}">${steps}</ol>`}${v.partial?'<p class="notice">Part delivered · remaining items still tracked</p>':''}</section><section aria-labelledby="items-title"><h2 id="items-title">${v.count===null?'Your order':v.count+' item'+(v.count===1?'':'s')}</h2><ul class="items">${rows}</ul>${rows?'':'<p class="empty">Item details haven’t been added yet.</p>'}${v.total===null?'':`<p class="total">Total<span><small>${escape(v.currency)}</small> ${money(v.total)}</span></p>`}</section><footer><p id="freshness"></p><button type="button" id="refresh">Refresh</button></footer>`;
    document.title = v.brand + ' · ' + v.stage;
    bind(); freshness();
    if (focused) document.getElementById('refresh').focus();
  }
  async function refresh() {
    try {
      const response = await fetch('status.json?t=' + Date.now(), {cache:'no-store', signal:AbortSignal.timeout(10000)});
      if (!response.ok) throw new Error('unavailable');
      const next = await response.json();
      if (next.version !== 1 || next.order !== data.order || next.app !== data.app) throw new Error('invalid');
      offline = false;
      const serialized = JSON.stringify(next);
      if (serialized !== signature) { signature = serialized; render(next); }
    } catch { offline = true; }
    freshness();
  }
  function bind() { document.getElementById('refresh').onclick = refresh; }
  bind(); freshness();
  setInterval(() => { freshness(); if (!document.hidden && !data.terminal) refresh(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
})();
