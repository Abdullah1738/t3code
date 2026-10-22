(() => {
  let data = JSON.parse(document.getElementById('initial').textContent);
  let signature = JSON.stringify(data);
  let offline = false;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = n => Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
  const main = document.querySelector('main');
  const bubble = matchMedia('(max-height:480px) and (max-width:480px)');
  // The Messages bubble can't scroll: keep only item rows that fit whole and say
  // how many are left, however tall the header got (long store, late ETA label).
  function fit() {
    const list = main.querySelector('ul.items');
    if (!list) return;
    const rows = [...list.children];
    rows.forEach(r => r.classList.remove('cut'));
    let more = main.querySelector('.more');
    if (more?.dataset.fit) { more.remove(); more = null; }
    if (more) { more.classList.remove('cut'); more.dataset.text ??= more.textContent; more.textContent = more.dataset.text; }
    if (!bubble.matches) return;
    const shown = () => rows.filter(r => r.getClientRects().length);
    const limit = () => list.parentElement.getBoundingClientRect().bottom + 0.5;
    const over = el => el && el.getClientRects().length && el.getBoundingClientRect().bottom > limit();
    if (!over(shown().at(-1)) && !over(more)) return;
    if (!more) { more = document.createElement('p'); more.className = 'more'; more.dataset.fit = '1'; list.after(more); }
    // Measure with the line already filled: an empty one has no height and would slip below.
    more.textContent = '+' + rows.length + ' more';
    let visible = shown();
    while (visible.length && (over(visible.at(-1)) || over(more))) { visible.at(-1).classList.add('cut'); visible = shown(); }
    more.textContent = '+' + (rows.length - visible.length) + ' more';
    // No room even for this line: the summary above already gives the count.
    if (over(more)) more.classList.add('cut');
  }
  function freshness() {
    const el = document.getElementById('freshness');
    if (data.sample) { el.textContent = 'Sample order'; fit(); return; }
    const t = Date.parse(data.checked_at);
    const minutes = Math.max(0, Math.floor((Date.now() - t) / 60000));
    el.textContent = offline ? 'Connection unavailable' : data.terminal ? 'Final update' : data.unavailable ? 'Tracking delayed' : minutes >= 5 ? 'Tracking may be stale' : 'Latest tracking check';
    el.classList.toggle('warn', !data.terminal && (offline || data.unavailable || minutes >= 5 || !Number.isFinite(t)));
    const time = document.createElement('time');
    time.dateTime = data.checked_at || '';
    time.textContent = Number.isFinite(t) ? (minutes < 1 ? 'Just now' : minutes + ' min ago') : 'No check received';
    el.append(time);
    if (!data.terminal && data.eta && Date.parse(data.eta) < Date.now()) {
      const when = document.querySelector('.when');
      if (when) when.textContent = 'Was expected by';
    }
    fit();
  }
  function render(v) {
    data = v;
    const steps = v.steps.map((s,i) => `<li class="${i<=v.index?'on':''}" ${i===v.index?'aria-current="step"':''}>${escape(s)}</li>`).join('');
    const rows = v.items.map(i => {const line=i.line_total??(i.price!==null?i.price*i.qty:null);return `<li class="${i.image?'has-photo':''}">${i.image?`<img src="${escape(i.image)}" alt="" width="56" height="56" loading="lazy" referrerpolicy="no-referrer">`:''}<span class="name"><span class="dish">${escape(i.name)}</span><span class="qty"> ×${i.qty}</span>${i.detail?`<span class="detail" dir="auto">${escape(i.detail)}</span>`:''}${i.pick?`<span class="pick" dir="auto">${escape(i.pick)}</span>`:''}</span>${line!==null?`<span class="price">${money(line)}</span>`:''}</li>`;}).join('');
    const focused = document.activeElement?.id === 'refresh';
    const heading = v.count===null?'Your order':v.count+' item'+(v.count===1?'':'s');
    const tally = [v.count===null?'':heading, v.total===null?'':v.currency+' '+money(v.total)].filter(Boolean).join(' · ');
    const summary = tally?`<p class="summary">${escape(tally)}</p>`:'';
    const more = v.items.length>3?`<p class="more">+${v.items.length-2} more</p>`:'';
    main.innerHTML = `<header class="eta"><div class="store">${escape(v.brand)}<span>${escape(v.store)}</span><span class="order">${escape(v.order)}</span></div>${v.sub?`<p class="when">${escape(v.sub)}</p>`:''}<h1 class="${(v.word??v.terminal)?([...v.big].length>16?'word long':'word'):''}">${escape(v.big)}</h1></header><section aria-label="Delivery progress"><p class="status" role="status">${escape(v.stage)}</p>${v.stage==='Cancelled'?'':`<ol class="steps" style="--steps:${v.steps.length}">${steps}</ol>`}${v.partial?'<p class="notice">Part delivered<span> · remaining items still tracked</span></p>':''}${summary}</section><section aria-labelledby="items-title"><h2 id="items-title">${heading}</h2><ul class="items">${rows}</ul>${more}${rows?'':'<p class="empty">Item details haven’t been added yet.</p>'}${v.total===null?'':`<p class="total">Total<span><small>${escape(v.currency)}</small> ${money(v.total)}</span></p>`}</section><footer><p id="freshness"></p><button type="button" id="refresh">Refresh</button></footer>`;
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
  addEventListener('resize', fit);
})();
