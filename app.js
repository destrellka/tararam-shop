/* Витрина ТАРАРАМ внутри Telegram.
   Каталог берётся из data.json (его выкладывает бот), корзина хранится на телефоне покупателя.
   Заказ уходит боту через Telegram.WebApp.sendData — бот проверяет цены и наличие и передаёт заказ менеджерам. */
'use strict';

const tg = window.Telegram && window.Telegram.WebApp;
const IN_TG = !!(tg && tg.platform && tg.platform !== 'unknown');
const ver = v => IN_TG && tg.isVersionAtLeast && tg.isVersionAtLeast(v);
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PAGE = 40;
const MAX_DATA = 4096; // столько байт Telegram пропускает от витрины к боту

const S = {
  shop: {}, delivery: {}, folders: {}, products: {}, order: [], out: new Set(), left: {},
  cart: {}, fav: [], profile: {}, route: { v: 'home' }, stack: [], sheet: null,
};

// ---------- Хранение на телефоне (облако Telegram, если есть, плюс память браузера) ----------
const store = {
  get(key) {
    let local = null;
    try { local = localStorage.getItem('tr_' + key); } catch (e) { /* приватный режим */ }
    if (!ver('6.9') || !tg.CloudStorage) return Promise.resolve(local);
    return new Promise(res => {
      const t = setTimeout(() => res(local), 1500);
      try {
        tg.CloudStorage.getItem(key, (err, val) => { clearTimeout(t); res(err ? local : (val || local)); });
      } catch (e) { clearTimeout(t); res(local); }
    });
  },
  set(key, val) {
    try { localStorage.setItem('tr_' + key, val); } catch (e) { /* ничего */ }
    if (ver('6.9') && tg.CloudStorage) try { tg.CloudStorage.setItem(key, val.slice(0, 4000), () => {}); } catch (e) { /* ничего */ }
  },
};
const parse = (s, dflt) => { try { return s ? JSON.parse(s) : dflt; } catch (e) { return dflt; } };

// ---------- Деньги и цены (как в боте) ----------
function money(v) {
  const [i, f] = (Math.round(v * 100) / 100).toFixed(2).split('.');
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (f === '00' ? '' : ',' + f) + ' ₽';
}
const minQty = p => p.t[0][0];
function unitPrice(p, q) {
  let price = null;
  for (const [from, pr] of p.t) if (q >= from) price = pr;
  return price;
}
const nextTier = (p, q) => p.t.find(([from]) => from > q && from <= maxQty(p));   // скидку, на которую не хватит склада, не предлагаем
const orderable = p => p && !S.out.has(p.i);
// Сколько штук есть на складе (undefined — остаток неизвестен, не ограничиваем)
const leftOf = p => (p && S.left[p.i] != null ? S.left[p.i] : undefined);
const maxQty = p => Math.min(100000, leftOf(p) ?? 100000);
const LOW = 50;   // больше этого — остаток зелёным, меньше — оранжевым
const leftTag = p => (orderable(p) && leftOf(p) != null
  ? `<span class="low${leftOf(p) > LOW ? ' many' : ''}">${leftOf(p) > LOW ? 'в наличии' : 'осталось'} ${leftOf(p)} ${un(p)}</span>` : '');
function capQ(p, q) {
  const m = maxQty(p);
  if (q > m) { toast(`На складе только ${m} ${un(p)}`); haptic('error'); return m; }
  return q;
}

// ---------- Поиск (как в боте: «ведро 3 литра» найдёт «Ведро 3л») ----------
const UNITS = {
  'л': 'л', 'литр': 'л', 'литра': 'л', 'литров': 'л', 'лит': 'л', 'мл': 'мл', 'миллилитр': 'мл', 'миллилитра': 'мл',
  'миллилитров': 'мл', 'см': 'см', 'сантиметр': 'см', 'сантиметров': 'см', 'мм': 'мм', 'миллиметр': 'мм',
  'миллиметров': 'мм', 'м': 'м', 'метр': 'м', 'метра': 'м', 'метров': 'м', 'шт': 'шт', 'штук': 'шт', 'штуки': 'шт',
  'штука': 'шт', 'пар': 'пар', 'пары': 'пар',
};
function tokens(text) {
  const words = [], nums = [];
  const toks = [...text.toLowerCase().replace(/ё/g, 'е').matchAll(/(\d+(?:[.,]\d+)?)|([a-zа-я]+)/g)];
  for (let i = 0; i < toks.length; i++) {
    const [, num, word] = toks[i];
    if (num) {
      let unit = null;
      if (i + 1 < toks.length && UNITS[toks[i + 1][2]]) { unit = UNITS[toks[i + 1][2]]; i++; }
      nums.push([num.replace(',', '.'), unit]);
    } else if (!UNITS[word]) words.push(word);
  }
  return [words, nums];
}
const stem = w => (w.length <= 3 ? w : w.slice(0, Math.max(3, w.length - 2)));
function numMatch([qn, qu], have) {
  return have.some(([n, u]) => {
    if (qu && u && qu !== u) return false;
    return qn.includes('.') ? parseFloat(n) === parseFloat(qn) : n.split('.')[0] === qn;
  });
}
function matches(q, p) {
  if (!p._ix) p._ix = tokens(p.n);
  const [words, nums] = p._ix;
  for (const w of q[0]) {
    const s = stem(w);
    if (!words.some(x => x.startsWith(s) || (w.length >= 3 && x.includes(w)))) return false;
  }
  return q[1].every(n => numMatch(n, nums));
}
function search(text) {
  text = text.trim();
  if (/^\d{5}$/.test(text) && S.products[text]) return [S.products[text]];
  const q = tokens(text);
  if (!q[0].length && !q[1].length) return [];
  return collapse(S.order.filter(p => orderable(p) && matches(q, p)));
}

// ---------- Каталог ----------
const EMOJI = /^(\p{Extended_Pictographic}[️‍\p{Extended_Pictographic}]*)\s*/u;
function prepare(data, avail) {
  S.shop = data.shop || {};
  S.delivery = data.delivery || {};
  S.out = new Set((avail && avail.out) || []);
  S.left = (avail && avail.left) || {};
  const F = {};
  for (const [id, [title, parent, kids]] of Object.entries(data.folders)) {
    const m = title.match(EMOJI);
    const emoji = m ? (m[1].includes('\uFE0F') || [...m[1]].length > 1 ? m[1] : m[1] + '\uFE0F') : '';
    F[id] = { id, title, parent, kids, emoji, name: m ? title.slice(m[0].length) : title, own: [] };
  }
  const tops = (F.f && F.f.kids) || [];
  tops.forEach((id, n) => { if (F[id]) F[id].hue = [340, 22, 200, 280, 40, 320, 12, 140, 180, 250][n % 10]; });
  const topOf = id => { let f = F[id]; while (f && f.parent && f.parent !== 'f') f = F[f.parent]; return f; };
  for (const [i, n, f, t, ph, d] of data.products) {
    if (!F[f]) continue;
    const top = topOf(f);
    const p = { i, n, f, t, ph, d, emoji: (top && top.emoji) || '📦', hue: (top && top.hue) || 340 };
    S.products[i] = p;
    S.order.push(p);
    F[f].own.push(p);
  }
  S.folders = F;
  for (const f of Object.values(F)) groupVariants(f.own);
  count('f');
}

// ---------- Фасовки: «Крышка 330 мл 10 шт» + «Крышка 330мл 50 шт» = одна карточка ----------
const PACK = /[\s,]*\(?(\d+)\s*(шт|штук|листов|лист|пар|уп|рулонов|рулона)\.?\)?\s*$/i;
function packOf(name) {
  const m = name.match(PACK);
  const base = (m ? name.slice(0, m.index) : name).replace(/[\s,]+$/, '');
  const key = base.toLowerCase().replace(/ё/g, 'е').replace(/(\d)\s+(?=[a-zа-я])/g, '$1').replace(/[\s,.]+/g, ' ').trim();
  return { key, base, n: m ? +m[1] : 1, unit: m ? m[2].toLowerCase() : 'шт' };
}
function groupVariants(items) {
  const by = {};
  for (const p of items) { const k = packOf(p.n); p._pk = k; (by[k.key] = by[k.key] || []).push(p); }
  for (const vs of Object.values(by)) {
    if (vs.length < 2 || new Set(vs.map(p => p._pk.n)).size < vs.length) continue;  // одинаковые фасовки не склеиваем
    vs.sort((a, b) => a._pk.n - b._pk.n);
    const g = { name: vs[0]._pk.base, items: vs };
    for (const p of vs) { p.g = g; p.pack = `${p._pk.n} ${p._pk.unit}`; }
  }
}
// Список товаров -> список карточек: из каждой группы фасовок одна карточка
function collapse(items) {
  const seen = new Set();
  return items.filter(p => !p.g || (!seen.has(p.g) && seen.add(p.g)));
}
const variants = p => (p.g ? p.g.items.filter(orderable) : [p]);
const multi = p => variants(p).length > 1;
const un = p => (p && p.g && p._pk.n > 1 ? 'уп.' : 'шт');   // фасовку «50 шт» считаем упаковками
function count(fid) {
  const f = S.folders[fid];
  f.n = collapse(f.own.filter(orderable)).length + f.kids.reduce((s, k) => s + (S.folders[k] ? count(k) : 0), 0);
  return f.n;
}
function allIn(fid, out = []) {
  const f = S.folders[fid];
  for (const p of collapse(f.own.filter(orderable))) out.push(p);
  for (const k of f.kids) if (S.folders[k]) allIn(k, out);
  return out;
}
function pathOf(fid) {
  const out = [];
  for (let f = S.folders[fid]; f && f.parent; f = S.folders[f.parent]) out.unshift(f);
  return out;
}

// ---------- Корзина и избранное ----------
const cartQty = id => S.cart[id] || 0;
function cartLines() {
  const lines = [];
  let total = 0;
  for (const [id, q] of Object.entries(S.cart)) {
    const p = S.products[id];
    if (!p) continue;
    const price = unitPrice(p, q) || p.t[0][1];
    lines.push({ p, q, price, sum: price * q });
    total += price * q;
  }
  return { lines, total: Math.round(total * 100) / 100 };
}
function setQty(id, q, silent) {
  const p = S.products[id];
  if (!p) return;
  q = Math.max(0, Math.min(maxQty(p), Math.floor(q) || 0));
  if (q && q < minQty(p)) q = 0;
  const had = cartQty(id);
  if (q) S.cart[id] = q; else delete S.cart[id];
  store.set('cart', JSON.stringify(S.cart));
  if (!silent) haptic(q > had ? 'light' : 'soft');
  refreshControls(id);
  updateChrome(q > had);
}
function toggleFav(id) {
  const on = S.fav.includes(id);
  S.fav = on ? S.fav.filter(x => x !== id) : [id, ...S.fav].slice(0, 500);
  store.set('fav', JSON.stringify(S.fav));
  haptic('select');
  toast(on ? 'Убрано из избранного' : '⭐ Добавлено в избранное');
  return !on;
}

// ---------- Отрисовка ----------
function thumb(p, cls = 'thumb') {
  const ph = `<div class="ph" style="--h:${p.hue}">${p.emoji}</div>`;
  if (!p.ph) return ph;
  return `<img class="${cls}" loading="lazy" alt="" src="${esc(p.ph)}" onerror="this.outerHTML=this.dataset.ph" data-ph="${esc(ph)}">`;
}
function ctl(p) {
  if (!orderable(p)) return '<span class="na">нет в наличии</span>';
  const q = cartQty(p.i);
  if (!q) return '<button class="add" data-act="inc" aria-label="В корзину">+</button>';
  return `<div class="step"><button data-act="dec" aria-label="Меньше">−</button><button class="q" data-act="open">${q}</button><button data-act="inc" aria-label="Больше">+</button></div>`;
}
function row(p) {
  if (multi(p)) return groupRow(p);
  const [mq, mp] = p.t[0];
  const last = p.t[p.t.length - 1];
  return `<div class="prod" data-id="${p.i}">
    <div data-act="open">${thumb(p)}</div>
    <div class="pinfo" data-act="open">
      <div class="pname">${esc(p.n)}</div>
      <div class="pprice">${money(mp)}${mq > 1 ? `<span class="min">от ${mq} шт</span>` : ''}</div>
      ${p.t.length > 1 ? `<span class="opt">от ${last[0]} шт — ${money(last[1])}</span>` : ''}
      ${leftTag(p)}
    </div>
    <div class="ctl">${ctl(p)}</div>
  </div>`;
}
function groupRow(p) {
  const vs = variants(p);
  const inCart = vs.filter(v => cartQty(v.i)).length;
  const from = Math.min(...vs.map(v => v.t[0][1]));
  return `<div class="prod" data-id="${p.i}">
    <div data-act="open">${thumb(p)}</div>
    <div class="pinfo" data-act="open">
      <div class="pname">${esc(p.g.name)}</div>
      <div class="pprice">от ${money(from)}</div>
      <div class="packs">${vs.map(v => `<span>${esc(v.pack)}${leftOf(v) != null ? ` · <b class="${leftOf(v) > LOW ? 'many' : 'few'}">${leftOf(v)} ${un(v)}</b>` : ''}</span>`).join('')}</div>
    </div>
    <div class="ctl"><button class="add${inCart ? ' in' : ''}" data-act="open" aria-label="Выбрать фасовку">${inCart ? '✓' : '+'}</button></div>
  </div>`;
}
function refreshControls(id) {
  const p0 = S.products[id];
  for (const v of p0 && p0.g ? p0.g.items : [p0]) {
    if (v) document.querySelectorAll(`.prod[data-id="${v.i}"]`).forEach(el => { el.outerHTML = row(v); });
  }
  if (S.route.v === 'cart') render(true);
  if (S.sheet && S.sheet.id === id) drawSheetDyn();
}

let observer = null;
function list(items, keep = 0) {
  if (observer) observer.disconnect();
  const box = $('#plist');
  if (!box) return;
  let shown = 0;
  const more = n => {
    const chunk = items.slice(shown, shown + n);
    shown += chunk.length;
    S.route.shown = shown;
    box.insertAdjacentHTML('beforeend', chunk.map(row).join(''));
    const tail = $('#more');
    if (tail) tail.hidden = shown >= items.length;
  };
  box.innerHTML = '';
  more(Math.max(PAGE, keep));
  observer = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) more(PAGE); }, { rootMargin: '600px' });
  const tail = $('#more');
  if (tail) observer.observe(tail);
}

const VIEWS = {
  home() {
    const tops = S.folders.f.kids.map(id => S.folders[id]).filter(f => f && f.n);
    const shop = S.shop;
    return `
    <section class="hero">
      <h2>Всё для праздника и упаковки</h2>
      <p>Одноразовая посуда, пакеты, коробки и декор. Чем больше берёте, тем дешевле.</p>
      <div class="chips"><span>${S.folders.f.n.toLocaleString('ru-RU')} товаров</span><span>опт и розница</span></div>
      <div class="deco">🎉</div><div class="deco2">🎁</div>
    </section>
    <div class="h"><h3>Каталог</h3><span>${tops.length} разделов</span></div>
    <div class="grid">${tops.map(f => `
      <button class="tile" style="--h:${f.hue}" data-go="folder" data-id="${f.id}">
        <div class="em">${f.emoji || '📦'}</div>
        <div><div class="tt">${esc(f.name)}</div><div class="tc">${f.n} товаров</div></div>
      </button>`).join('')}
    </div>
    <div class="info">
      ${shop.address ? `<div><span>📍</span><span><b>Самовывоз:</b> ${esc(shop.address)}</span></div>` : ''}
      ${shop.hours ? `<div><span>🕘</span><span>${esc(shop.hours).replace(/\n/g, ' · ')}</span></div>` : ''}
      ${shop.support ? `<div><span>💬</span><span>Вопросы: <a href="https://t.me/${esc(shop.support.replace('@', ''))}" data-act="tglink">${esc(shop.support)}</a></span></div>` : ''}
    </div>`;
  },
  folder(r) {
    const f = S.folders[r.id];
    if (!f) return VIEWS.home();
    const path = pathOf(f.id);
    const kids = f.kids.map(id => S.folders[id]).filter(k => k && k.n);
    return `
    <div class="crumbs"><button data-go="home">Каталог</button>${path.slice(0, -1).map(x => ` › <button data-go="folder" data-id="${x.id}">${esc(x.name)}</button>`).join('')}</div>
    <div class="vt">${f.emoji ? f.emoji + ' ' : ''}${esc(f.name)}<small>${f.n}</small></div>
    ${kids.length ? `<div class="kids">${kids.map(k => `<button class="kid" data-go="folder" data-id="${k.id}">${esc(k.name)}<em>${k.n}</em></button>`).join('')}</div>` : ''}
    <div class="plist" id="plist"></div><div class="more" id="more">Загружаю ещё…</div>`;
  },
  search(r) {
    r.items = search(r.q);
    if (!r.items.length) {
      return `<div class="empty"><div class="big">🔍</div><b>Ничего не нашлось</b>По запросу «${esc(r.q)}» товаров нет. Попробуйте другое слово, например «контейнер» или «пакет».</div>`;
    }
    return `<div class="vt">Поиск<small>${r.items.length}</small></div><div class="plist" id="plist"></div><div class="more" id="more">Загружаю ещё…</div>`;
  },
  fav(r) {
    r.items = S.fav.map(id => S.products[id]).filter(Boolean);
    if (!r.items.length) {
      return `<div class="empty"><div class="big">⭐</div><b>В избранном пусто</b>Откройте товар и нажмите ☆, чтобы быстро находить его потом.<br><button class="btn ghost" data-go="home">Перейти в каталог</button></div>`;
    }
    return `<div class="vt">Избранное<small>${r.items.length}</small></div><div class="plist" id="plist"></div><div class="more" id="more"></div>`;
  },
  cart() {
    const { lines, total } = cartLines();
    if (!lines.length) {
      return `<div class="empty"><div class="big">🛒</div><b>Корзина пока пуста</b>Загляните в каталог или найдите товар через поиск.<br><button class="btn" data-go="home">Перейти в каталог</button></div>`;
    }
    return `
    <div class="vt">Корзина<small>${lines.length} поз.</small></div>
    <div class="card">${lines.map(({ p, q, price, sum }) => {
      const nx = nextTier(p, q);
      const gone = !orderable(p);
      const over = !gone && leftOf(p) != null && q > leftOf(p);
      return `<div class="line" data-id="${p.i}">
        <div data-act="open">${thumb(p)}</div>
        <div>
          <div class="nm" data-act="open">${esc(p.n)}</div>
          ${gone ? '<div class="warn">Сейчас нет в наличии — уберите из корзины</div>' : ''}
          ${over ? `<div class="warn">На складе только ${leftOf(p)} шт — уменьшите количество</div>` : ''}
          <div class="row"><div class="ctl">${ctl(p).replace('<span class="na">нет в наличии</span>', '<button class="linkbtn danger" data-act="del">Убрать</button>')}</div>
            <div class="sum"><b>${money(sum)}</b><small>${q} × ${money(price)}</small></div></div>
          ${nx && !gone ? `<div class="hint">💡 Ещё ${nx[0] - q} шт — и цена ${money(nx[1])}/шт</div>` : ''}
        </div>
      </div>`;
    }).join('')}</div>
    <div class="card totals">
      <div><span>Товары</span><span>${money(total)}</span></div>
      <div class="grand"><span>Итого</span><span>${money(total)}</span></div>
      <p class="note">${esc(S.delivery.note || '')}</p>
    </div>
    <button class="linkbtn danger" data-act="clear">Очистить корзину</button>`;
  },
  checkout() {
    const { lines, total } = cartLines();
    if (!lines.length) return VIEWS.cart();
    const pr = S.profile;
    const mode = pr.d === 'delivery' ? 'delivery' : 'pickup';
    const user = (IN_TG && tg.initDataUnsafe && tg.initDataUnsafe.user) || {};
    const canContact = ver('6.9') && typeof tg.requestContact === 'function';
    return `
    <div class="vt">Оформление</div>
    <div class="sec-t">Как получить</div>
    <div class="card">
      <div class="seg" id="seg">
        <button type="button" data-act="mode" data-mode="pickup" class="${mode === 'pickup' ? 'on' : ''}">🏪 Самовывоз</button>
        <button type="button" data-act="mode" data-mode="delivery" class="${mode === 'delivery' ? 'on' : ''}">🚚 Доставка</button>
      </div>
      <div class="modeinfo" id="modeinfo"></div>
      <label class="field" id="addrf" ${mode === 'delivery' ? '' : 'hidden'} style="margin-top:12px">
        <span>Адрес доставки</span>
        <textarea id="f-addr" rows="2" maxlength="300" placeholder="Город, улица, дом, квартира или офис">${esc(pr.a || '')}</textarea>
      </label>
    </div>
    <div class="sec-t">Контакты</div>
    <div class="card">
      <label class="field"><span>Как к вам обращаться</span>
        <input id="f-name" maxlength="100" autocomplete="name" value="${esc(pr.n || user.first_name || '')}" placeholder="Имя"></label>
      <label class="field"><span>Телефон</span>
        <input id="f-phone" type="tel" inputmode="tel" maxlength="30" autocomplete="tel" value="${esc(pr.p || '')}" placeholder="+7 900 123-45-67"></label>
      ${canContact ? '<button type="button" class="linkbtn" data-act="contact">📱 Взять номер из Telegram</button>' : ''}
    </div>
    <div class="sec-t">Комментарий</div>
    <div class="card">
      <label class="field"><textarea id="f-comment" rows="2" maxlength="500" placeholder="Например: позвоните заранее"></textarea></label>
    </div>
    <div class="card totals" id="totals"></div>
    <p class="note">Менеджер свяжется с вами, чтобы подтвердить наличие и время получения.</p>`;
  },
};

function deliveryCost(total) {
  const d = S.delivery;
  if (d.price == null) return null;
  if (d.free_from && total >= d.free_from) return 0;
  return d.price;
}
function checkoutMode() {
  const on = document.querySelector('#seg .on');
  return on ? on.dataset.mode : 'pickup';
}
function drawCheckoutParts() {
  const mode = checkoutMode();
  const { lines, total } = cartLines();
  const info = $('#modeinfo');
  if (!info) return;
  info.innerHTML = mode === 'pickup'
    ? `📍 <b>${esc(S.shop.address || '')}</b><br>🕘 ${esc(S.shop.hours || '').replace(/\n/g, ' · ')}`
    : `🚚 ${esc(S.delivery.note || '')}`;
  $('#addrf').hidden = mode !== 'delivery';
  const cost = mode === 'delivery' ? deliveryCost(total) : 0;
  const rows = [`<div><span>Товары (${lines.length} поз.)</span><span>${money(total)}</span></div>`];
  if (mode === 'delivery') rows.push(`<div><span>Доставка</span><span>${cost == null ? 'уточнит менеджер' : cost ? money(cost) : 'бесплатно'}</span></div>`);
  rows.push(`<div class="grand"><span>Итого</span><span>${money(total + (cost || 0))}</span></div>`);
  $('#totals').innerHTML = rows.join('');
}

function render(keepScroll) {
  const r = S.route;
  const y = window.scrollY;
  $('#view').innerHTML = VIEWS[r.v](r);
  if (r.v === 'folder') list(allIn(r.id), r.shown);
  if (r.v === 'search' && r.items.length) list(r.items, r.shown);
  if (r.v === 'fav' && r.items.length) list(r.items, r.items.length);
  if (r.v === 'checkout') drawCheckoutParts();
  $('#top').hidden = r.v === 'cart' || r.v === 'checkout';
  window.scrollTo(0, keepScroll ? y : (r.y || 0));
  updateChrome();
}

function updateChrome(bump) {
  const { lines, total } = cartLines();
  const badge = $('#badge');
  badge.hidden = !lines.length;
  badge.textContent = lines.length;
  if (bump) { badge.classList.remove('bump'); void badge.offsetWidth; badge.classList.add('bump'); }
  const tab = { home: 'home', folder: 'home', search: 'home', fav: 'fav', cart: 'cart', checkout: 'cart' }[S.route.v];
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));

  const cta = $('#cta'), btn = $('#ctabtn');
  btn.className = '';
  if (S.route.v === 'checkout') {
    const cost = checkoutMode() === 'delivery' ? deliveryCost(total) || 0 : 0;
    btn.className = 'center';
    btn.innerHTML = `<span>Отправить заказ</span><span>${money(total + cost)}</span>`;
    cta.hidden = !lines.length;
  } else if (S.route.v === 'cart') {
    btn.innerHTML = `<span>Оформить заказ</span><span>${money(total)}</span>`;
    cta.hidden = !lines.length;
  } else {
    btn.innerHTML = `<span>🛒 Корзина · ${lines.length} поз.</span><span>${money(total)}</span>`;
    cta.hidden = !lines.length;
  }
  if (IN_TG && ver('6.1')) {
    if (S.stack.length || S.sheet) tg.BackButton.show(); else tg.BackButton.hide();
  }
}

// ---------- Навигация ----------
function go(route, push = true) {
  S.route.y = window.scrollY;
  if (push) S.stack.push(S.route); else S.stack = route.v === 'home' ? [] : [{ v: 'home' }];
  S.route = route;
  if (route.v !== 'search') { $('#q').value = ''; $('#qclear').hidden = true; }
  render();
}
function back() {
  if (S.sheet) return closeSheet();
  if (!S.stack.length) return;
  S.route = S.stack.pop();
  if (S.route.v === 'search') $('#q').value = S.route.q;
  render();
}

// ---------- Карточка товара ----------
function openSheet(id) {
  const p = S.products[id];
  if (!p) return;
  S.sheet = { id, q: cartQty(id) || minQty(p) };
  $('#sheet').hidden = false;
  document.body.style.overflow = 'hidden';
  drawSheet();
  updateChrome();
}
function closeSheet() {
  S.sheet = null;
  $('#sheet').hidden = true;
  document.body.style.overflow = '';
  updateChrome();
}
function drawSheet() {
  const p = S.products[S.sheet.id];
  const ok = orderable(p);
  const fav = S.fav.includes(p.i);
  const path = pathOf(p.f).map(f => f.name).join(' › ');
  const favBtn = `<button class="fav ${fav ? 'on' : ''}" data-act="fav" aria-label="Избранное">${fav ? '⭐' : '☆'}</button>`;
  $('#sheetbody').innerHTML = `
    <div class="grip"></div>
    <div class="hero-ph" style="--h:${p.hue}">${p.ph ? `<img src="${esc(p.ph)}" alt="" onerror="this.outerHTML='${p.emoji}'">` : p.emoji}</div>
    <h2>${esc(multi(p) ? p.g.name : p.n)}</h2>
    ${multi(p) ? `<div class="vars"><small>Фасовка</small><div>${variants(p).map(v => `<button class="var${v.i === p.i ? ' on' : ''}" data-act="variant" data-v="${v.i}">${esc(v.pack)}${cartQty(v.i) ? ' ✓' : ''}</button>`).join('')}</div></div>` : ''}
    <div class="where">${esc(path)} · код ${esc(p.i)}</div>
    ${ok && leftOf(p) != null ? `<div class="stock">✅ На складе: ${leftOf(p)} ${un(p)}</div>` : ''}
    ${p.d ? `<p class="desc">${esc(p.d)}</p>` : ''}
    <div class="tiers" id="stiers">${p.t.map(([from, pr]) => `<div class="tier"><small>${from === 1 ? `за 1 ${un(p)}` : `от ${from} ${un(p)}`}</small><b>${money(pr)}</b></div>`).join('')}</div>
    ${ok ? `
    <div class="qrow">
      <div class="qbox"><button data-act="sdec" aria-label="Меньше">−</button>
        <input id="sq" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" value="${S.sheet.q}" aria-label="Количество">
        <button data-act="sinc" aria-label="Больше">+</button></div>
      ${favBtn}
    </div>
    <div class="quick">${[5, 10, 50, 100].map(n => `<button data-act="sadd" data-n="${n}">+${n}</button>`).join('')}</div>`
    : `<div class="qrow"><div class="warn" style="flex:1">😔 Сейчас нет в наличии</div>${favBtn}</div>`}
    <div id="sdyn"></div>`;
  const inp = $('#sq');
  if (inp) {
    inp.addEventListener('input', () => {
      inp.value = inp.value.replace(/\D/g, '');
      const v = parseInt(inp.value, 10);
      if (v > 0) { S.sheet.q = Math.min(v, maxQty(S.products[S.sheet.id])); if (v > S.sheet.q) { inp.value = S.sheet.q; toast(`На складе только ${S.sheet.q} ${un(S.products[S.sheet.id])}`); } drawSheetDyn(false); }
    });
    inp.addEventListener('blur', () => { inp.value = S.sheet.q; });
  }
  drawSheetDyn(false);
}
function drawSheetDyn(syncInput = true) {
  if (!S.sheet) return;
  const p = S.products[S.sheet.id];
  const q = S.sheet.q;
  const inCart = cartQty(p.i);
  const box = $('#sdyn');
  if (syncInput && $('#sq')) $('#sq').value = q;
  let active = -1;
  p.t.forEach(([from], n) => { if (q >= from) active = n; });
  document.querySelectorAll('#stiers .tier').forEach((el, n) => el.classList.toggle('on', n === active));
  if (!orderable(p)) {
    box.innerHTML = inCart ? '<button class="big-btn" data-act="sdel">Убрать из корзины</button>' : '';
    return;
  }
  const price = unitPrice(p, q);
  const nx = nextTier(p, q);
  box.innerHTML = `
    ${price == null ? `<div class="warn">Этот товар продаётся от ${minQty(p)} шт.</div>`
    : `<div class="calc"><span>${q} ${un(p)} × ${money(price)}</span><b>${money(price * q)}</b></div>`}
    ${nx && price != null ? `<div class="tip">💡 Возьмите ещё ${nx[0] - q} шт — будет по ${money(nx[1])} за штуку</div>` : ''}
    <button class="big-btn" data-act="sput" ${price == null ? 'disabled' : ''}>${inCart ? (inCart === q ? '✓ Уже в корзине' : 'Обновить корзину') : 'Добавить в корзину'}</button>
    ${inCart ? '<button class="linkbtn danger" data-act="sdel" style="width:100%;margin-top:6px">Убрать из корзины</button>' : ''}`;
}

// ---------- Оформление ----------
function fieldError(id, text) {
  const el = $(id).closest('.field');
  el.classList.add('bad');
  if (!el.querySelector('.err')) el.insertAdjacentHTML('beforeend', `<div class="err">${text}</div>`);
  $(id).focus();
  haptic('error');
}
function submit() {
  document.querySelectorAll('.field.bad').forEach(el => { el.classList.remove('bad'); const e = el.querySelector('.err'); if (e) e.remove(); });
  const mode = checkoutMode();
  const n = $('#f-name').value.trim();
  const p = $('#f-phone').value.trim();
  const a = mode === 'delivery' ? $('#f-addr').value.trim() : '';
  const c = $('#f-comment').value.trim();
  if (!n) return fieldError('#f-name', 'Напишите, как к вам обращаться');
  if (p.replace(/\D/g, '').length < 10) return fieldError('#f-phone', 'Напишите номер полностью, например +7 900 123-45-67');
  if (mode === 'delivery' && a.length < 5) return fieldError('#f-addr', 'Напишите адрес доставки');
  const { lines, total } = cartLines();
  const gone = lines.filter(l => !orderable(l.p));
  if (gone.length) { toast('Уберите из корзины то, чего нет в наличии'); go({ v: 'cart' }, false); return; }
  const over = lines.filter(l => leftOf(l.p) != null && l.q > leftOf(l.p));
  if (over.length) { toast('Столько нет на складе — поправьте количество в корзине'); go({ v: 'cart' }, false); return; }
  const payload = JSON.stringify({ v: 1, i: lines.map(l => [l.p.i, l.q]), n, p, d: mode, a, c, t: total });
  if (new TextEncoder().encode(payload).length > MAX_DATA) {
    toast('Слишком большой заказ для одного раза. Разделите его на два или сократите комментарий.');
    return;
  }
  S.profile = { n, p, a: a || S.profile.a || '', d: mode };
  store.set('profile', JSON.stringify(S.profile));
  if (!IN_TG) { toast('Заказ отправляется только из Telegram: откройте магазин кнопкой в боте'); return; }
  if (tg.initDataUnsafe && tg.initDataUnsafe.query_id) {
    // Открыто кнопкой из сообщения: такие окна не могут прислать заказ боту. Корзина уже сохранена в Telegram.
    tg.showAlert('Корзина сохранена ✅\n\nЧтобы отправить заказ, нажмите «🛍 Открыть магазин» в меню под полем ввода сообщения. Корзина будет там же.', () => tg.close());
    return;
  }
  haptic('success');
  S.cart = {};
  store.set('cart', '{}');
  tg.sendData(payload); // Telegram закроет витрину, а бот пришлёт подтверждение в чат
}
function askContact() {
  tg.requestContact((shared, res) => {
    const phone = shared && res && res.responseUnsafe && res.responseUnsafe.contact && res.responseUnsafe.contact.phone_number;
    if (phone) {
      $('#f-phone').value = phone.startsWith('+') ? phone : '+' + phone;
      haptic('success');
    } else if (shared) {
      toast('Номер отправлен в чат. Впишите его и сюда, пожалуйста');
    }
  });
}

// ---------- Мелочи ----------
let toastTimer = null;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}
function haptic(kind) {
  if (!ver('6.1')) return;
  const h = tg.HapticFeedback;
  try {
    if (kind === 'select') h.selectionChanged();
    else if (kind === 'success' || kind === 'error') h.notificationOccurred(kind);
    else h.impactOccurred(kind);
  } catch (e) { /* старый Telegram */ }
}

// ---------- События ----------
document.addEventListener('click', e => {
  const goEl = e.target.closest('[data-go]');
  if (goEl) {
    const v = goEl.dataset.go;
    if (v === 'folder') go({ v, id: goEl.dataset.id }); else go({ v }, v !== 'home' && v !== 'fav');
    return;
  }
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    closeSheet();
    if (tab.dataset.tab === S.route.v && S.route.v === 'home') { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    go({ v: tab.dataset.tab }, false);
    return;
  }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const holder = el.closest('[data-id]');
  const id = holder && holder.dataset.id;
  const p = id && S.products[id];
  const sp = S.sheet && S.products[S.sheet.id];
  switch (act) {
    case 'open': if (id) openSheet(id); break;
    case 'inc': if (p) setQty(id, capQ(p, cartQty(id) ? cartQty(id) + 1 : minQty(p))); if (p && cartQty(id) === minQty(p) && minQty(p) > 1) toast(`Этот товар продаётся от ${minQty(p)} шт`); break;
    case 'dec': if (p) setQty(id, cartQty(id) - 1 < minQty(p) ? 0 : cartQty(id) - 1); break;
    case 'del': if (p) setQty(id, 0); break;
    case 'clear':
      if (IN_TG && ver('6.2')) tg.showConfirm('Очистить корзину?', ok => { if (ok) { S.cart = {}; store.set('cart', '{}'); render(); } });
      else if (confirm('Очистить корзину?')) { S.cart = {}; store.set('cart', '{}'); render(); }
      break;
    case 'close': closeSheet(); break;
    case 'sinc': S.sheet.q = capQ(sp, S.sheet.q + 1); haptic('select'); drawSheetDyn(); break;
    case 'sdec': S.sheet.q = Math.max(minQty(sp), S.sheet.q - 1); haptic('select'); drawSheetDyn(); break;
    case 'sadd': S.sheet.q = capQ(sp, S.sheet.q + Number(el.dataset.n)); haptic('select'); drawSheetDyn(); break;
    case 'sput': {
      const q = Math.min(maxQty(sp), Math.max(minQty(sp), S.sheet.q));
      const had = cartQty(sp.i);
      setQty(sp.i, q);
      toast(had ? `Корзина обновлена: ${q} ${un(sp)}` : `✅ Добавлено: ${q} ${un(sp)}`);
      closeSheet();
      break;
    }
    case 'sdel': setQty(sp.i, 0); toast('Убрано из корзины'); closeSheet(); break;
    case 'variant': {
      const v = S.products[el.dataset.v];
      if (v) { S.sheet = { id: v.i, q: cartQty(v.i) || minQty(v) }; haptic('select'); drawSheet(); }
      break;
    }
    case 'fav': toggleFav(sp.i); drawSheet(); if (S.route.v === 'fav') render(true); break;
    case 'mode':
      document.querySelectorAll('#seg button').forEach(b => b.classList.toggle('on', b === el));
      haptic('select');
      drawCheckoutParts();
      updateChrome();
      break;
    case 'contact': askContact(); break;
    case 'tglink':
      if (IN_TG && ver('6.1')) { e.preventDefault(); tg.openTelegramLink(el.href); }
      break;
    default: break;
  }
});
$('#ctabtn').addEventListener('click', () => {
  if (S.route.v === 'checkout') submit();
  else if (S.route.v === 'cart') go({ v: 'checkout' });
  else go({ v: 'cart' });
});
let searchTimer = null;
$('#q').addEventListener('input', e => {
  const q = e.target.value;
  $('#qclear').hidden = !q;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (!q.trim()) { if (S.route.v === 'search') back(); return; }
    if (S.route.v === 'search') { S.route = { v: 'search', q }; render(); } else go({ v: 'search', q });
  }, 180);
});
$('#q').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
$('#qclear').addEventListener('click', () => { $('#q').value = ''; $('#qclear').hidden = true; if (S.route.v === 'search') back(); });

// ---------- Запуск ----------
async function getJson(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(url + ': ' + r.status);
  return r.json();
}
async function start() {
  if (IN_TG) {
    tg.ready();
    if (tg.onEvent) tg.onEvent('themeChanged', () => document.documentElement.classList.toggle('dark', tg.colorScheme === 'dark'));
    tg.expand();
    if (ver('6.1')) {
      try { tg.setHeaderColor('secondary_bg_color'); tg.setBackgroundColor('secondary_bg_color'); } catch (e) { /* ничего */ }
      tg.BackButton.onClick(back);
    }
    if (ver('7.7')) try { tg.disableVerticalSwipes(); } catch (e) { /* ничего */ }
  }
  try {
    let v = '';
    try { v = (await getJson('version.json?t=' + Date.now())).v || ''; } catch (e) { /* без версии тоже работаем */ }
    const [data, avail, cart, fav, profile] = await Promise.all([
      getJson('data.json?v=' + v), getJson('avail.json?v=' + v).catch(() => ({ out: [], left: {} })),
      store.get('cart'), store.get('fav'), store.get('profile'),
    ]);
    prepare(data, avail);
    S.cart = {};
    let cut = 0;
    for (const [id, q] of Object.entries(parse(cart, {}))) {
      if (!S.products[id] || !(q > 0)) continue;
      const m = maxQty(S.products[id]);
      S.cart[id] = q > m && m >= minQty(S.products[id]) ? (cut++, m) : q;
    }
    if (cut) { store.set('cart', JSON.stringify(S.cart)); setTimeout(() => toast('Часть товаров закончилась на складе — количество в корзине уменьшено'), 400); }
    S.fav = parse(fav, []).filter(id => S.products[id]);
    S.profile = parse(profile, {});
    render();
  } catch (e) {
    $('#view').innerHTML = `<div class="empty"><div class="big">😔</div><b>Не получилось загрузить каталог</b>Проверьте интернет и откройте магазин ещё раз.<br><button class="btn" onclick="location.reload()">Обновить</button></div>`;
  }
}
start();
