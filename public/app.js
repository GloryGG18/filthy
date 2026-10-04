import { dict, errors, pickLang, LANG_NAMES, LANG_FLAGS } from './i18n.js';

const tg = window.Telegram?.WebApp;
const inTg = !!tg?.initData; // the SDK object also exists in a plain browser, but without initData
tg?.ready();
tg?.expand();
tg?.setHeaderColor?.('#0a0a0a');
tg?.setBackgroundColor?.('#0a0a0a');

const TZ = 'Europe/Bratislava';
const LANGS = ['ru', 'uk', 'en'];
let lang = pickLang();
let t = dict[lang];
let me = null;
let cleanup = [];

// Dev mode in a normal browser: open /?dev=123 (server must run with DEV_AUTH=1).
const devUser = (() => {
  const q = new URLSearchParams(location.search).get('dev');
  try {
    if (q) localStorage.setItem('devUser', q);
    return q || localStorage.getItem('devUser');
  } catch { return q; }
})();

// ---------- helpers ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v; // only for server-generated SVG
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (tg?.initData) headers['X-Telegram-Init-Data'] = tg.initData;
  else if (devUser) headers['X-Dev-User'] = devUser;
  let body = opts.body;
  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(path, { method: opts.method || (body ? 'POST' : 'GET'), headers, body });
  if (opts.raw) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(errors[lang][data.error] || data.error || res.statusText);
    err.code = data.error;
    throw err;
  }
  return data;
}

const eur = (c) => `${(c / 100).toFixed(c % 100 ? 2 : 0)} €`;
const uah = (k) => `${Math.round(k / 100).toLocaleString('uk-UA')} ₴`;
const locale = () => ({ uk: 'uk-UA', ru: 'ru-RU', en: 'en-GB' })[lang];
const fmtDate = (ms) => new Date(ms).toLocaleString(locale(), { weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: TZ });
const fmtTime = (ms) => new Date(ms).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', timeZone: TZ });

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2400);
}
const haptic = (type) => inTg && tg.HapticFeedback?.notificationOccurred?.(type);
const confirmBox = (msg) => new Promise((ok) => (inTg && tg.showConfirm ? tg.showConfirm(msg, ok) : ok(confirm(msg))));

function copyBtn(value) {
  return h('button', { class: 'btn sm secondary', onclick: async () => {
    try { await navigator.clipboard.writeText(value); } catch {
      const i = h('input', { value }); document.body.append(i); i.select(); document.execCommand('copy'); i.remove();
    }
    toast(t.copied);
  } }, t.copy);
}

function fieldRow(label, value, copy) {
  return h('div', { class: 'row' },
    h('div', { class: 'grow' }, h('div', { class: 'lbl' }, label), h('div', { class: 'val' }, value)),
    copy ? copyBtn(copy) : null);
}

function every(ms, fn) {
  const id = setInterval(fn, ms);
  cleanup.push(() => clearInterval(id));
}

const view = () => document.getElementById('app');
const render = (...nodes) => view().replaceChildren(...nodes.flat());
const loading = () => render(h('div', { class: 'spinner' }));
const go = (hash) => { location.hash = hash; };

// ---------- guest: events ----------

function eventCard(e) {
  return h('a', { class: 'card link event-card', href: `#event/${e.id}` },
    e.poster ? h('img', { class: 'poster', src: e.poster, alt: '' }) : null,
    h('div', { class: 'body' },
      h('div', { class: 'date' }, fmtDate(e.starts_at)),
      h('h2', {}, e.title),
      h('div', { class: 'row' },
        h('span', { class: 'grow muted' }, [e.club, e.city].filter(Boolean).join(' · ')),
        h('span', { class: 'badge accent' }, `${t.from} ${eur(Math.min(e.price_online, e.price_repost))}`))));
}

async function pageEvents() {
  const events = await api('/api/events');
  render(h('div', { class: 'stack' },
    events.length ? events.map(eventCard) : h('p', { class: 'muted center' }, t.no_events)));
}

async function pageEvent(id) {
  const [e, tickets] = await Promise.all([api(`/api/events/${id}`), api('/api/tickets')]);
  const mine = tickets.filter((x) => x.event.id === e.id && !['cancelled', 'rejected'].includes(x.status));
  const soldOut = e.seats_left === 0;
  const started = e.starts_at < Date.now();

  const buy = async (tier) => {
    if (soldOut && tier === 'online') return;
    try {
      const ticket = await api('/api/tickets', { body: { event_id: e.id, tier } });
      go(`ticket/${ticket.id}`);
    } catch (err) { toast(err.message); }
  };

  const tier = (key, price, title, desc, enabled) =>
    h('div', { class: `card tier ${enabled ? '' : 'disabled'}`, onclick: enabled ? () => buy(key) : null },
      h('div', { class: 'grow' }, h('h3', {}, title), h('div', { class: 'muted small' }, desc)),
      h('div', { class: 'price' }, eur(price)));

  render(h('div', { class: 'stack' },
    e.poster ? h('img', { class: 'poster', src: e.poster, alt: '' }) : null,
    h('div', {},
      h('div', { class: 'date' }, fmtDate(e.starts_at)),
      h('h1', {}, e.title),
      h('div', { class: 'row' },
        h('span', { class: 'badge' }, t.age(e.age_limit)),
        e.seats_left != null ? h('span', { class: `badge ${soldOut ? 'bad' : ''}` }, soldOut ? t.sold_out : t.seats_left(e.seats_left)) : null)),
    h('dl', { class: 'kv card' },
      h('dt', {}, t.where), h('dd', {}, [e.club, e.address, e.city].filter(Boolean).join(', ')),
      e.lineup ? [h('dt', {}, t.lineup), h('dd', {}, e.lineup)] : null),
    e.description ? h('p', { style: 'white-space:pre-line' }, e.description) : null,
    mine.map((x) => h('a', { class: 'card link row', href: `#ticket/${x.id}` },
      h('span', { class: 'grow' }, `${t.ticket_no}${x.code}`), statusBadge(x.status))),
    started ? null : [
      tier('online', e.price_online, t.online, t.online_desc, !soldOut),
      tier('repost', e.price_repost, t.repost, t.repost_desc(me.settings.instagram, me.settings.min_followers), !soldOut),
      h('div', { class: 'card tier disabled' },
        h('div', { class: 'grow' }, h('h3', {}, t.at_door), h('div', { class: 'muted small' }, t.at_door_desc)),
        h('div', { class: 'price' }, eur(e.price_door))),
    ]));
}

// ---------- guest: tickets ----------

function statusBadge(s) {
  const cls = { need_proof: 'warn', paid: 'ok', used: '', awaiting_payment: 'warn', pending_approval: 'warn', approved: 'warn', expired: 'bad', rejected: 'bad' }[s] || '';
  return h('span', { class: `badge ${cls}` }, t.status[s] || s);
}

async function pageTickets() {
  const list = await api('/api/tickets');
  render(h('div', { class: 'stack' },
    h('h1', {}, t.my_tickets),
    list.length ? list.map((x) => h('a', { class: 'card link row', href: `#ticket/${x.id}` },
      x.event.poster ? h('img', { class: 'poster sm', src: x.event.poster, alt: '' }) : null,
      h('div', { class: 'grow' },
        h('div', { class: 'date' }, fmtDate(x.event.starts_at)),
        h('h3', {}, x.event.title),
        h('div', { class: 'row small' }, statusBadge(x.status), h('span', { class: 'muted' }, `${t.tier[x.tier]} · ${eur(x.price)}`)))))
      : h('p', { class: 'muted center' }, t.no_tickets)));
}

async function pageTicket(id, method) {
  const x = await api(`/api/tickets/${id}`);
  const header = h('div', {},
    h('div', { class: 'date' }, fmtDate(x.event.starts_at)),
    h('h1', {}, x.event.title),
    h('div', { class: 'row' }, statusBadge(x.status === 'pending_approval' && !x.proof ? 'need_proof' : x.status), h('span', { class: 'muted small' }, `${t.tier[x.tier]} · ${eur(x.price)}`)));

  // Valid ticket: QR for the door.
  if (x.status === 'paid' || x.status === 'used') {
    return render(h('div', { class: 'stack' }, header,
      h('div', { class: 'qr', html: x.qr, style: x.status === 'used' ? 'opacity:.35' : '' }),
      h('div', { class: 'ticket-code' }, x.code),
      h('p', { class: 'center muted' }, x.status === 'used' ? t.used_at(fmtTime(x.used_at)) : t.show_qr),
      h('dl', { class: 'kv card' },
        h('dt', {}, t.where), h('dd', {}, [x.event.club, x.event.address, x.event.city].filter(Boolean).join(', ')))));
  }

  // Repost: upload screenshots, then wait for approval.
  if (x.status === 'pending_approval' || x.status === 'rejected') {
    if (x.status === 'pending_approval' && x.proof?.status === 'pending') {
      every(8000, async () => {
        const n = await api(`/api/tickets/${id}`).catch(() => null);
        if (n && n.status !== x.status) route();
      });
      return render(h('div', { class: 'stack' }, header,
        h('div', { class: 'card center' }, h('div', { style: 'font-size:40px' }, '⏳'), h('p', {}, t.proof_pending)),
        h('button', { class: 'btn ghost', onclick: () => cancel(x) }, t.cancel_ticket)));
    }
    return render(h('div', { class: 'stack' }, header, uploadForm(x),
      x.status === 'rejected' ? [h('p', { class: 'muted small center' }, t.rejected_hint),
        h('button', { class: 'btn secondary', onclick: async () => {
          const n = await api('/api/tickets', { body: { event_id: x.event.id, tier: 'online' } }).catch((e) => toast(e.message));
          if (n) go(`ticket/${n.id}`);
        } }, `${t.buy_online_instead} · ${eur(x.event.price_online)}`)] : null));
  }

  // Payable: choose a method, then show payment details and poll until the money arrives.
  const methods = me.settings.methods;
  if (!method && x.status === 'awaiting_payment') {
    try { method = sessionStorage.getItem(`pm-${id}`); } catch { /* ignore */ }
  }
  if (!method) {
    const opt = (key, title, desc) => h('div', { class: 'card tier', onclick: () => pageTicket(id, key) },
      h('div', { class: 'grow' }, h('h3', {}, title), h('div', { class: 'muted small' }, desc)), h('div', { class: 'price' }, '›'));
    return render(h('div', { class: 'stack' }, header,
      h('h2', {}, t.pay_how),
      methods.paybysquare ? opt('paybysquare', t.pbs, t.pbs_desc) : null,
      methods.monobank ? opt('monobank', me.settings.mono_mode === 'card' ? t.mono_card_label : t.mono, t.mono_desc) : null,
      !methods.paybysquare && !methods.monobank ? h('p', { class: 'muted' }, t.no_methods) : null,
      h('button', { class: 'btn ghost', onclick: () => cancel(x) }, t.cancel_ticket)));
  }

  loading();
  let pay;
  try {
    pay = await api(`/api/tickets/${id}/pay`, { body: { method } });
  } catch (e) {
    toast(e.message);
    try { sessionStorage.removeItem(`pm-${id}`); } catch { /* ignore */ }
    return pageTicket(id);
  }
  try { sessionStorage.setItem(`pm-${id}`, method); } catch { /* ignore */ }

  const timer = h('p', { class: 'center muted small' });
  const tick = () => {
    const left = Math.ceil((pay.ticket.reserved_until - Date.now()) / 60000);
    timer.textContent = left > 0 ? t.reserved(left) : t.reservation_over;
    timer.onclick = left > 0 ? null : () => pageTicket(id, method);
  };
  tick();
  every(15000, tick);
  every(5000, async () => {
    const n = await api(`/api/tickets/${id}`).catch(() => null);
    if (n?.status === 'paid') { haptic('success'); route(); }
  });

  const details = method === 'paybysquare'
    ? [
      h('div', { class: 'qr', html: pay.paybysquare.svg }),
      h('p', { class: 'small muted' }, t.pbs_steps),
      h('div', { class: 'card fields' },
        fieldRow(t.amount, eur(pay.paybysquare.amount)),
        fieldRow(t.iban, pay.paybysquare.iban, pay.paybysquare.iban.replace(/\s/g, '')),
        fieldRow(t.vs, pay.paybysquare.variable_symbol, pay.paybysquare.variable_symbol),
        fieldRow(t.beneficiary, pay.paybysquare.beneficiary)),
    ]
    : [
      h('div', { class: 'card center' },
        h('div', { class: 'muted small' }, t.amount),
        h('div', { class: 'ticket-code' }, uah(pay.monobank.uah)),
        h('div', { class: 'muted small' }, `${eur(x.price)} · ${t.rate} ${pay.monobank.rate.toFixed(2)}`)),
      ...(pay.monobank.mode === 'card' ? [
        h('div', { class: 'card fields' },
          fieldRow(t.card_no, pay.monobank.card, pay.monobank.card.replace(/\s/g, '')),
          fieldRow(t.exact_amount, uah(pay.monobank.uah), (pay.monobank.uah / 100).toFixed(2)),
          fieldRow(h('b', { style: 'color:var(--warn)' }, t.comment_required), h('b', {}, pay.monobank.comment), pay.monobank.comment)),
        h('div', { class: 'notice warn' }, t.mono_comment_required(pay.monobank.comment)),
        h('p', { class: 'small muted' }, t.mono_card_steps),
      ] : [
        h('div', { class: 'card fields' },
          fieldRow(t.comment, pay.monobank.comment, pay.monobank.comment),
          fieldRow(t.amount, uah(pay.monobank.uah), String(Math.round(pay.monobank.uah / 100)))),
        h('p', { class: 'small muted' }, t.mono_steps),
        h('button', { class: 'btn', onclick: () => (inTg ? tg.openLink(pay.monobank.jar_url) : window.open(pay.monobank.jar_url)) }, t.mono_open),
      ]),
    ];

  render(h('div', { class: 'stack' }, header, timer, ...details,
    h('div', { class: 'row center muted small', style: 'justify-content:center' }, h('div', { class: 'spinner', style: 'width:16px;height:16px;margin:0;border-width:2px' }), t.waiting_payment),
    h('button', { class: 'btn ghost', onclick: () => { try { sessionStorage.removeItem(`pm-${id}`); } catch { /* ignore */ } pageTicket(id, null); } }, t.change_method)));
}

async function cancel(x) {
  if (!(await confirmBox(`${t.cancel_ticket}?`))) return;
  await api(`/api/tickets/${x.id}/cancel`, { method: 'POST' }).catch((e) => toast(e.message));
  go(`event/${x.event.id}`);
}

function uploadForm(x) {
  const files = {};
  const slot = (key, label) => {
    const preview = h('div', {}, '＋');
    const input = h('input', { type: 'file', accept: 'image/*', onchange: () => {
      const f = input.files[0];
      if (!f) return;
      files[key] = f;
      preview.replaceChildren(h('img', { src: URL.createObjectURL(f), alt: '' }), f.name);
    } });
    return h('label', { class: 'upload' }, input, preview, h('div', { class: 'small' }, label));
  };
  const insta = h('input', { placeholder: '@username', autocomplete: 'off' });
  const btn = h('button', { class: 'btn', onclick: async () => {
    if (!files.story || !files.profile) return toast(t.need_both);
    btn.disabled = true; btn.textContent = t.sending;
    const fd = new FormData();
    fd.append('instagram', insta.value);
    fd.append('story', files.story);
    fd.append('profile', files.profile);
    try { await api(`/api/tickets/${x.id}/proofs`, { body: fd }); route(); } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = t.send; }
  } }, t.send);
  return h('div', { class: 'stack' },
    h('h2', {}, t.upload_title),
    h('p', { class: 'muted small' }, t.repost_desc(me.settings.instagram, me.settings.min_followers)),
    h('div', { class: 'grid2' }, slot('story', t.upload_story), slot('profile', t.upload_profile)),
    h('div', { class: 'field' }, h('label', {}, t.instagram), insta),
    btn);
}

// ---------- door ----------

async function pageDoor(eventId) {
  if (!eventId) {
    const events = await api('/api/door/events');
    if (events.length === 1) return go(`door/${events[0].id}`);
    return render(h('div', { class: 'stack' }, h('h1', {}, t.choose_event),
      events.map((e) => h('a', { class: 'card link', href: `#door/${e.id}` },
        h('div', { class: 'date' }, fmtDate(e.starts_at)), h('h3', {}, e.title), h('span', { class: 'muted small' }, `${t.entered}: ${e.entered}`)))));
  }
  const ev = await api(`/api/events/${eventId}`);
  const stats = h('div', { class: 'grid3' });
  const sales = h('div', { class: 'muted small center' });
  const refresh = async () => {
    const s = await api(`/api/door/stats?event_id=${eventId}`).catch(() => null);
    if (!s) return;
    stats.replaceChildren(
      h('div', { class: 'card stat' }, h('b', {}, s.entered), h('span', {}, t.entered)),
      h('div', { class: 'card stat' }, h('b', {}, s.expected), h('span', {}, t.expected)),
      h('div', { class: 'card stat' }, h('b', {}, s.my_scans), h('span', {}, t.scanned_in)));
    const c = s.my_sales.cash, k = s.my_sales.card;
    sales.textContent = `${t.my_sales}: ${t.cash} ${c?.n || 0} × = ${eur(c?.total || 0)} · ${t.card} ${k?.n || 0} × = ${eur(k?.total || 0)}`;
  };
  refresh();
  every(10000, refresh);

  const check = async (text) => {
    try {
      const r = await api('/api/door/scan', { body: { event_id: Number(eventId), text } });
      showResult(r);
      refresh();
    } catch (e) { toast(e.message); }
  };

  const openScanner = () => {
    if (!inTg || !tg.showScanQrPopup) return toast(t.scanner_unavailable);
    tg.showScanQrPopup({ text: ev.title }, (text) => {
      check(text);
      return true; // close after the first code; the result screen reopens the scanner on tap
    });
  };

  const showResult = (r) => {
    const map = { ok: ['ok', '✓', t.r_ok], used: ['bad', '✕', t.r_used], unpaid: ['warn', '!', t.r_unpaid], invalid: ['bad', '✕', t.r_invalid], wrong_event: ['bad', '✕', t.r_wrong_event] };
    const [cls, icon, label] = map[r.result];
    haptic(r.result === 'ok' ? 'success' : 'error');
    const sub = r.result === 'used' ? t.used_at(fmtTime(r.used_at)) + (r.used_by ? ` · ${r.used_by}` : '')
      : r.result === 'wrong_event' ? `${r.event.title} · ${fmtDate(r.event.starts_at)}`
      : r.ticket ? `${t.tier[r.ticket.tier]} · ${r.ticket.guest_name || ''}` : '';
    const overlay = h('div', { class: `result ${cls}`, onclick: () => { overlay.remove(); if (inTg && tg.showScanQrPopup) openScanner(); } },
      h('div', { class: 'icon' }, icon), h('div', { class: 'big' }, label), h('div', { class: 'sub' }, sub),
      r.ticket ? h('div', {}, `${t.ticket_no}${r.ticket.code}`) : null,
      h('div', { class: 'hint' }, `${t.entered}: ${r.entered} · ${t.tap_next}`));
    document.body.append(overlay);
    cleanup.push(() => overlay.remove());
  };

  const code = h('input', { inputmode: 'numeric', placeholder: t.manual_code, maxlength: 8 });
  const amount = h('input', { inputmode: 'decimal', value: (ev.price_door / 100).toString() });
  const name = h('input', { placeholder: t.guest_name });
  const sell = async (method) => {
    const a = Number(amount.value.replace(',', '.'));
    if (!(await confirmBox(t.confirm_sale(eur(Math.round(a * 100)), t[method])))) return;
    try {
      await api('/api/door/sale', { body: { event_id: Number(eventId), method, amount: a, name: name.value } });
      haptic('success'); toast(t.sold); name.value = ''; refresh();
    } catch (e) { toast(e.message); }
  };

  render(h('div', { class: 'stack' },
    h('div', {}, h('div', { class: 'date' }, fmtDate(ev.starts_at)), h('h2', {}, ev.title)),
    stats,
    h('button', { class: 'btn', style: 'padding:22px;font-size:18px', onclick: openScanner }, `📷 ${t.scan}`),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, code), h('button', { class: 'btn sm secondary', onclick: () => code.value && check(code.value) }, t.check)),
    h('div', { class: 'card stack' },
      h('h3', {}, t.sell),
      h('div', { class: 'grid2' }, h('div', {}, h('label', {}, t.amount + ', €'), amount), h('div', {}, h('label', {}, t.guest_name), name)),
      h('div', { class: 'grid2' },
        h('button', { class: 'btn ok', onclick: () => sell('cash') }, `💶 ${t.cash}`),
        h('button', { class: 'btn secondary', onclick: () => sell('card') }, `💳 ${t.card}`))),
    sales));
}

// ---------- admin ----------

function adminNav(active) {
  const items = [['events', t.a_events], ['approvals', t.a_approvals], ['payments', t.a_payments], ['search', t.a_search], ['staff', t.a_staff], ['settings', t.a_settings]];
  return h('div', { class: 'seg scroll', style: 'overflow-x:auto' },
    items.map(([k, label]) => h('button', { class: active === k ? 'on' : '', onclick: () => go(`admin/${k}`) }, label)));
}

async function pageAdmin(section = 'events', id, sub) {
  if (section === 'events' && id === 'new') return adminEventForm(null);
  if (section === 'events' && id && sub === 'report') return adminReport(id);
  if (section === 'events' && id) return adminEventForm(id);
  const body = h('div', { class: 'stack' });
  render(h('div', { class: 'stack' }, adminNav(section), body));
  const fill = (...n) => body.replaceChildren(...n.flat());

  if (section === 'events') {
    const events = await api('/api/admin/events');
    fill(h('a', { class: 'btn', href: '#admin/events/new' }, `＋ ${t.new_event}`),
      events.map((e) => h('div', { class: 'card' },
        h('a', { class: 'row', href: `#admin/events/${e.id}` },
          e.poster ? h('img', { class: 'poster sm', src: e.poster, alt: '' }) : null,
          h('div', { class: 'grow' },
            h('div', { class: 'date' }, fmtDate(e.starts_at)), h('h3', {}, e.title),
            h('span', { class: `badge ${e.status === 'published' ? 'ok' : ''}` }, t[`st_${e.status}`]),
            h('span', { class: 'muted small' }, ` ${t.entered}: ${e.entered}`))),
        h('div', { class: 'row', style: 'margin-top:10px' },
          h('a', { class: 'btn sm secondary', href: `#admin/events/${e.id}/report` }, t.report),
          h('a', { class: 'btn sm secondary', href: `#door/${e.id}` }, t.door)))));
  }

  if (section === 'approvals') {
    const list = await api('/api/admin/approvals');
    fill(list.length ? list.map((p) => {
      const card = h('div', { class: 'card stack' },
        h('div', {}, h('h3', {}, p.guest + (p.username ? ` @${p.username}` : '')),
          h('div', { class: 'muted small' }, `${p.event_title} · ${t.ticket_no}${p.code} · Instagram: ${p.instagram || '—'}`)),
        h('div', { class: 'proof-imgs' },
          h('a', { href: p.story_url, target: '_blank' }, h('img', { src: p.story_url, alt: '' })),
          h('a', { href: p.profile_url, target: '_blank' }, h('img', { src: p.profile_url, alt: '' }))),
        h('div', { class: 'grid2' },
          h('button', { class: 'btn ok', onclick: () => review(true) }, t.approve),
          h('button', { class: 'btn bad', onclick: () => review(false) }, t.reject)));
      const review = async (approve) => {
        await api(`/api/admin/approvals/${p.id}`, { body: { approve } }).catch((e) => toast(e.message));
        haptic('success'); card.remove();
      };
      return card;
    }) : h('p', { class: 'muted center' }, t.no_approvals));
  }

  if (section === 'payments') {
    const list = await api('/api/admin/payments');
    fill(list.length ? list.map((p) => {
      const codeIn = h('input', { inputmode: 'numeric', placeholder: t.manual_code, value: p.ticket_code || '' });
      const resolve = async (attach) => {
        await api(`/api/admin/payments/${p.id}/resolve`, { body: attach ? { ticket_code: codeIn.value } : {} }).catch((e) => toast(e.message));
        route();
      };
      const amt = p.currency === 'UAH' ? uah(p.amount) : eur(p.amount);
      return h('div', { class: 'card stack' },
        h('div', { class: 'row' }, h('b', { class: 'grow' }, `${amt} · ${p.source}`), h('span', { class: `badge ${p.status === 'underpaid' ? 'warn' : 'bad'}` }, p.status)),
        h('div', { class: 'small muted' }, `${fmtDate(p.received_at)} · ${p.payer || ''}`),
        h('div', { class: 'small' }, `«${p.reference || '—'}»`),
        p.ticket_code ? h('div', { class: 'small muted' }, `${t.ticket_no}${p.ticket_code}: ${eur(p.ticket_price)}${p.uah_expected ? ' / ' + uah(p.uah_expected) : ''} · ${t.status[p.ticket_status] || p.ticket_status}`) : null,
        h('div', { class: 'row' }, h('div', { class: 'grow' }, codeIn), h('button', { class: 'btn sm', onclick: () => resolve(true) }, t.attach)),
        h('button', { class: 'btn ghost', onclick: () => resolve(false) }, t.resolve));
    }) : h('p', { class: 'muted center' }, t.no_payments));
  }

  if (section === 'search') {
    const q = h('input', { placeholder: t.search_hint });
    const out = h('div', { class: 'stack' });
    const search = async () => {
      const rows = await api(`/api/admin/tickets?q=${encodeURIComponent(q.value)}`);
      out.replaceChildren(...rows.map((r) => h('div', { class: 'card stack' },
        h('div', { class: 'row' }, h('b', { class: 'grow' }, `${r.code} · ${r.guest_name || ''} ${r.username ? '@' + r.username : ''}`), statusBadge(r.status)),
        h('div', { class: 'small muted' }, `${r.event_title} · ${t.tier[r.tier]} · ${eur(r.price)} · ${r.pay_method || ''}`),
        ['awaiting_payment', 'expired', 'approved', 'pending_approval'].includes(r.status)
          ? h('button', { class: 'btn sm secondary', onclick: async () => {
            if (!(await confirmBox(`${t.mark_paid}: ${r.code}?`))) return;
            await api(`/api/admin/tickets/${r.code}/mark-paid`, { method: 'POST' }).catch((e) => toast(e.message));
            search();
          } }, t.mark_paid) : null)));
    };
    q.addEventListener('keydown', (e) => e.key === 'Enter' && search());
    fill(h('div', { class: 'row' }, h('div', { class: 'grow' }, q), h('button', { class: 'btn sm', onclick: search }, '🔍')), out);
  }

  if (section === 'settings') return adminSettings(fill);

  if (section === 'staff') {
    const list = await api('/api/admin/staff');
    const who = h('input', { placeholder: '@username' });
    const role = h('select', {}, h('option', { value: 'controller' }, t.r_controller), h('option', { value: 'admin' }, t.r_admin));
    const setRole = async (user, r) => {
      try { await api('/api/admin/staff', { body: { user, role: r } }); route(); } catch (e) { toast(e.message); }
    };
    fill(h('div', { class: 'card stack' },
      h('div', { class: 'small muted' }, t.user_hint),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, who), h('div', { style: 'width:130px' }, role)),
      h('button', { class: 'btn', onclick: () => setRole(who.value, role.value) }, t.add)),
    h('div', { class: 'card' }, list.map((u) => h('div', { class: 'list-item' },
      h('div', { class: 'grow' }, h('b', {}, u.name), h('div', { class: 'muted small' }, `${u.username ? '@' + u.username : u.tg_id} · ${t[`r_${u.role}`]}`)),
      u.tg_id !== me.user.id ? h('button', { class: 'btn sm secondary', onclick: () => setRole(String(u.tg_id), 'guest') }, t.r_guest) : null))));
  }
}

async function adminSettings(fill) {
  const { values: v, bank_providers, mono_modes } = await api('/api/admin/settings');
  const inputs = {};
  const clear = new Set();
  const text = (key, label, attrs = {}) => {
    inputs[key] = h('input', { value: v[key] ?? '', autocomplete: 'off', ...attrs });
    return h('div', { class: 'field' }, h('label', {}, label), inputs[key]);
  };
  // Secrets are shown masked; leave empty to keep the saved value.
  const secret = (key, label) => {
    inputs[key] = h('input', { type: 'password', autocomplete: 'new-password', placeholder: v[key].set ? `${t.s_saved} ${v[key].masked}` : t.s_not_set });
    return h('div', { class: 'field' }, h('label', {}, label),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, inputs[key]),
        v[key].set ? h('button', { class: 'btn sm secondary', onclick: (e) => {
          clear.add(key); inputs[key].value = ''; inputs[key].placeholder = t.s_will_clear; e.target.remove();
        } }, '✕') : null));
  };
  inputs.mono_mode = h('select', {}, mono_modes.map((m) => h('option', { value: m, selected: v.mono_mode === m }, t[`s_mode_${m}`])));
  inputs.bank_provider = h('select', {}, bank_providers.map((p) => h('option', { value: p, selected: v.bank_provider === p }, t[`s_bank_${p}`])));
  const jars = h('div', { class: 'stack' });
  const findJars = async () => {
    jars.replaceChildren(h('div', { class: 'spinner', style: 'margin:8px auto' }));
    try {
      const { jars: list, cards } = await api('/api/admin/settings/mono-jars');
      jars.replaceChildren(...(list.length || cards.length ? [
        ...cards.map((c) => h('button', { class: 'btn secondary', onclick: () => {
          inputs.mono_account_id.value = c.id; inputs.mono_mode.value = 'card'; toast('✓');
        } }, `💳 ${c.pan} · ${c.type}`)),
        ...list.map((j) => h('button', { class: 'btn secondary', onclick: () => {
          inputs.mono_jar_id.value = j.id; if (j.url) inputs.mono_jar_url.value = j.url; inputs.mono_mode.value = 'jar'; toast('✓');
        } }, `🫙 ${j.title} · ${uah(j.balance || 0)}`)),
      ] : [h('p', { class: 'muted small' }, t.s_no_jars)]));
    } catch (e) { jars.replaceChildren(h('p', { class: 'muted small' }, e.message)); }
  };
  const save = async () => {
    const values = {};
    for (const [k, el] of Object.entries(inputs)) values[k] = el.value;
    try {
      await api('/api/admin/settings', { method: 'PUT', body: { values, clear: [...clear] } });
      haptic('success'); toast(t.s_saved_ok); route();
    } catch (e) { toast(e.message); }
  };
  fill(
    h('p', { class: 'muted small' }, t.s_intro),
    h('div', { class: 'card' }, h('h3', {}, 'PAY by square'),
      text('pbs_iban', 'IBAN', { placeholder: 'SK00 0000 0000 0000 0000 0000' }),
      text('pbs_bic', 'BIC / SWIFT', { placeholder: 'TATRSKBX' }),
      text('pbs_beneficiary', t.beneficiary)),
    h('div', { class: 'card' }, h('h3', {}, t.s_bank),
      h('div', { class: 'field' }, h('label', {}, t.s_bank_source), inputs.bank_provider),
      secret('fio_token', 'Fio API token'),
      text('tatra_client_id', 'Tatra banka client ID'),
      secret('tatra_client_secret', 'Tatra banka client secret'),
      text('tatra_account_id', 'Tatra banka account ID')),
    h('div', { class: 'card' }, h('h3', {}, 'monobank'),
      h('details', { class: 'help' }, h('summary', {}, t.s_mono_how),
        h('ol', {}, t.s_mono_steps.map((step) => h('li', {}, step))),
        h('a', { class: 'btn sm secondary', href: 'https://api.monobank.ua/', target: '_blank', onclick: (e) => {
          if (tg?.openLink) { e.preventDefault(); tg.openLink('https://api.monobank.ua/'); }
        } }, 'api.monobank.ua ↗')),
      secret('mono_token', t.s_mono_token),
      h('div', { class: 'field' }, h('label', {}, t.s_mono_mode), inputs.mono_mode),
      h('p', { class: 'muted small' }, t.s_card_hint),
      h('button', { class: 'btn sm secondary', style: 'margin-top:10px', onclick: findJars }, t.s_find_accounts),
      jars,
      text('mono_card', t.s_card, { inputmode: 'numeric', placeholder: '5375 4141 0000 0000' }),
      text('mono_account_id', t.s_account_id),
      text('mono_jar_id', t.s_jar_id),
      text('mono_jar_url', t.s_jar_url, { placeholder: 'https://send.monobank.ua/jar/…' }),
      text('mono_tolerance', t.s_tolerance, { inputmode: 'decimal' })),
    h('button', { class: 'btn', onclick: save }, t.save));
}

async function adminEventForm(id) {
  const e = id ? (await api('/api/admin/events')).find((x) => x.id === Number(id)) : null;
  const toLocal = (ms) => { const d = new Date(ms); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
  const f = {};
  const field = (key, label, el) => { f[key] = el; return h('div', { class: 'field' }, h('label', {}, label), el); };
  const inp = (v, attrs = {}) => h('input', { value: v ?? '', ...attrs });
  const status = h('select', {}, ['draft', 'published', 'closed'].map((s) => h('option', { value: s, selected: e?.status === s }, t[`st_${s}`])));
  const posterIn = h('input', { type: 'file', accept: 'image/*' });

  const save = async () => {
    const body = {
      title: f.title.value, description: f.description.value, club: f.club.value, city: f.city.value, address: f.address.value,
      lineup: f.lineup.value, starts_at: f.starts_at.value ? new Date(f.starts_at.value).getTime() : null,
      price_online: f.price_online.value, price_repost: f.price_repost.value, price_door: f.price_door.value,
      capacity: f.capacity.value, age_limit: f.age_limit.value, status: status.value,
    };
    try {
      const saved = id ? await api(`/api/admin/events/${id}`, { method: 'PUT', body }) : await api('/api/admin/events', { body });
      if (posterIn.files[0]) {
        const fd = new FormData(); fd.append('poster', posterIn.files[0]);
        await api(`/api/admin/events/${saved.id}/poster`, { body: fd });
      }
      toast('✓'); go('admin/events');
    } catch (err) { toast(err.message); }
  };
  const removePoster = async () => {
    if (!(await confirmBox(t.remove_poster_q))) return;
    try { await api(`/api/admin/events/${id}/poster`, { method: 'DELETE' }); toast('✓'); route(); } catch (err) { toast(err.message); }
  };
  const deleteEvent = async () => {
    if (!(await confirmBox(t.delete_event_q))) return;
    try { await api(`/api/admin/events/${id}`, { method: 'DELETE' }); haptic('success'); toast('✓'); go('admin/events'); } catch (err) { toast(err.message); }
  };
  const broadcast = async () => {
    if (!(await confirmBox(t.broadcast_q))) return;
    try { const r = await api(`/api/admin/events/${id}/broadcast`, { body: {} }); toast(t.broadcast_done(r.queued)); } catch (err) { toast(err.message); }
  };

  render(h('div', { class: 'stack' },
    h('h1', {}, e ? e.title : t.new_event),
    e?.poster ? h('img', { class: 'poster', src: e.poster, alt: '', style: 'max-height:240px;object-fit:contain' }) : null,
    e?.poster ? h('button', { class: 'btn sm secondary', onclick: removePoster }, `🗑 ${t.remove_poster}`) : null,
    h('div', { class: 'card' },
      field('title', t.title, inp(e?.title)),
      field('starts_at', t.starts_at, inp(e ? toLocal(e.starts_at) : '', { type: 'datetime-local' })),
      h('div', { class: 'grid2' }, field('club', t.club, inp(e?.club)), field('city', t.city, inp(e?.city ?? 'Bratislava'))),
      field('address', t.address, inp(e?.address)),
      field('lineup', t.lineup, inp(e?.lineup)),
      field('description', t.description, h('textarea', {}, e?.description ?? '')),
      h('div', { class: 'grid3' },
        field('price_online', t.price_online, inp(e ? e.price_online / 100 : 10, { inputmode: 'decimal' })),
        field('price_repost', t.price_repost, inp(e ? e.price_repost / 100 : 8, { inputmode: 'decimal' })),
        field('price_door', t.price_door, inp(e ? e.price_door / 100 : 12, { inputmode: 'decimal' }))),
      h('div', { class: 'grid2' },
        field('capacity', t.capacity, inp(e?.capacity ?? '', { inputmode: 'numeric', placeholder: '∞' })),
        field('age_limit', t.age_limit, inp(e?.age_limit ?? 18, { inputmode: 'numeric' }))),
      h('div', { class: 'field' }, h('label', {}, t.poster), posterIn),
      h('div', { class: 'field' }, h('label', {}, 'Status'), status)),
    h('button', { class: 'btn', onclick: save }, t.save),
    id ? h('button', { class: 'btn secondary', onclick: broadcast }, `📣 ${t.broadcast}`) : null,
    id ? h('a', { class: 'btn secondary', href: `#admin/events/${id}/report` }, t.report) : null,
    id ? h('button', { class: 'btn ghost', style: 'color:var(--bad)', onclick: deleteEvent }, `🗑 ${t.delete_event}`) : null));
}

async function adminReport(id) {
  const r = await api(`/api/admin/events/${id}/report`);
  const line = (label, v, cls = '') => h('tr', {}, h('td', {}, label), h('td', { class: `r ${cls}` }, v));
  const diffCls = (d) => (d == null ? '' : d < 0 ? 'neg' : d > 0 ? 'pos' : '');
  const diffTxt = (d) => (d == null ? '—' : `${d > 0 ? '+' : ''}${eur(d)}`);

  const countCash = async (c) => {
    const v = prompt(`${t.count_cash}: ${c.name} (${t.cash_expected} ${eur(c.cash_total)})`, (c.counted ?? c.cash_total) / 100);
    if (v == null) return;
    await api(`/api/admin/events/${id}/cash`, { body: { controller_id: c.tg_id, counted: Number(v.replace(',', '.')) } }).catch((e) => toast(e.message));
    route();
  };
  const csv = async () => {
    if (!inTg) {
      const res = await api(`/api/admin/events/${id}/csv?download=1`, { method: 'POST', raw: true });
      const a = h('a', { href: URL.createObjectURL(await res.blob()), download: `filthy-${id}.csv` }); a.click();
      return;
    }
    await api(`/api/admin/events/${id}/csv`, { method: 'POST' }).then(() => toast(t.csv_sent)).catch((e) => toast(e.message));
  };
  const names = new Map(r.controllers.map((c) => [c.tg_id, c.name]));

  render(h('div', { class: 'stack' },
    h('div', {}, h('div', { class: 'date' }, fmtDate(r.event.starts_at)), h('h1', {}, r.event.title)),
    h('div', { class: 'grid3' },
      h('div', { class: 'card stat' }, h('b', {}, r.entered), h('span', {}, t.entered)),
      h('div', { class: 'card stat' }, h('b', {}, eur(r.totals.online + r.totals.door)), h('span', {}, 'Σ')),
      h('div', { class: 'card stat' }, h('b', {}, r.paid_not_entered), h('span', {}, t.paid_not_entered))),
    h('div', { class: 'card' }, h('table', {},
      h('tr', {}, h('th', {}, t.online_total), h('th', { class: 'r' }, eur(r.totals.online))),
      line('PAY by square', `${r.online.paybysquare.n} × · ${eur(r.online.paybysquare.total)}`),
      line('monobank', `${r.online.monobank.n} × · ${eur(r.online.monobank.total)}`),
      r.online.manual.n ? line('manual', `${r.online.manual.n} × · ${eur(r.online.manual.total)}`) : null,
      line(t.discounts, String(r.online.repost.n)),
      h('tr', {}, h('th', {}, t.door_total), h('th', { class: 'r' }, eur(r.totals.door))),
      line(t.cash, `${r.door.cash.n} × · ${eur(r.door.cash.total)}`),
      line(t.card, `${r.door.card.n} × · ${eur(r.door.card.total)}`),
      h('tr', {}, h('th', {}, t.cash_counted), h('th', { class: 'r' }, r.totals.cash_counted == null ? '—' : eur(r.totals.cash_counted))),
      line(t.diff, r.totals.cash_counted == null ? '—' : diffTxt(r.totals.cash_counted - r.totals.cash_expected),
        r.totals.cash_counted == null ? '' : diffCls(r.totals.cash_counted - r.totals.cash_expected)))),
    h('h2', {}, t.controllers),
    h('div', { class: 'card' }, h('table', {},
      h('tr', {}, h('th', {}, ''), h('th', { class: 'r' }, t.scanned_in), h('th', { class: 'r' }, t.cash), h('th', { class: 'r' }, t.card), h('th', { class: 'r' }, t.diff)),
      r.controllers.map((c) => h('tr', { onclick: () => countCash(c), style: 'cursor:pointer' },
        h('td', {}, c.name), h('td', { class: 'r' }, c.scanned_in), h('td', { class: 'r' }, eur(c.cash_total)),
        h('td', { class: 'r' }, eur(c.card_total)), h('td', { class: `r ${diffCls(c.cash_diff)}` }, diffTxt(c.cash_diff)))))),
    h('p', { class: 'small muted' }, `${t.count_cash}: ↑`),
    h('button', { class: 'btn secondary', onclick: csv }, `⬇ ${t.csv}`),
    r.door_sales.length ? [h('h2', {}, t.door_sales), h('div', { class: 'card' }, h('table', {},
      r.door_sales.map((s) => h('tr', {}, h('td', {}, fmtTime(s.created_at)), h('td', {}, names.get(s.sold_by) || s.sold_by),
        h('td', {}, t[s.pay_method]), h('td', { class: 'r' }, eur(s.price))))))] : null));
}

// ---------- shell ----------

function renderTabs(active) {
  const tabs = [['', '🎉', t.events], ['tickets', '🎟', t.my_tickets]];
  if (['controller', 'admin'].includes(me?.user.role)) tabs.push(['door', '📷', t.door]);
  if (me?.user.role === 'admin') tabs.push(['admin', '⚙️', t.admin]);
  document.getElementById('tabs').replaceChildren(...tabs.map(([k, ic, label]) =>
    h('a', { href: `#${k}`, class: active === k ? 'on' : '' }, h('span', { class: 'ic' }, ic), label)));
}

async function route() {
  cleanup.forEach((f) => f());
  cleanup = [];
  const [page, ...args] = location.hash.replace(/^#\/?/, '').split('/');
  const tab = { '': '', event: '', tickets: 'tickets', ticket: 'tickets', door: 'door', admin: 'admin' }[page] ?? '';
  renderTabs(tab);
  if (tg?.BackButton) {
    if (['event', 'ticket'].includes(page) || (page === 'admin' && args.length > 1) || (page === 'door' && args[0])) tg.BackButton.show();
    else tg.BackButton.hide();
  }
  loading();
  try {
    if (page === 'event') await pageEvent(args[0]);
    else if (page === 'tickets') await pageTickets();
    else if (page === 'ticket') await pageTicket(args[0]);
    else if (page === 'door') await pageDoor(args[0]);
    else if (page === 'admin') await pageAdmin(args[0], args[1], args[2]);
    else await pageEvents();
  } catch (e) {
    render(h('p', { class: 'muted center' }, e.message));
  }
  window.scrollTo(0, 0);
}

const langButton = () => { document.getElementById('lang').textContent = `${LANG_FLAGS[lang]} ${lang.toUpperCase()} ▾`; };

function setLang(l, { save = true } = {}) {
  lang = l; t = dict[l];
  try { localStorage.setItem('lang', l); } catch { /* ignore */ }
  document.documentElement.lang = l;
  langButton();
  // Saved on the server too, so the bot writes to this guest in the same language.
  if (save && me) api('/api/me/lang', { method: 'PUT', body: { lang: l } }).catch(() => {});
  route();
}

function openLangPicker() {
  const sheet = h('div', { class: 'sheet-backdrop', onclick: (e) => { if (e.target === sheet) sheet.remove(); } },
    h('div', { class: 'sheet' },
      h('h3', { class: 'center' }, '🌐 Язык · Мова · Language'),
      LANGS.map((l) => h('button', { class: `btn ${l === lang ? '' : 'secondary'}`, onclick: () => { sheet.remove(); setLang(l); } },
        `${LANG_FLAGS[l]}  ${LANG_NAMES[l]}`))));
  document.body.append(sheet);
}

tg?.BackButton?.onClick(() => history.back());
document.getElementById('lang').onclick = openLangPicker;
window.addEventListener('hashchange', route);

(async () => {
  langButton();
  document.documentElement.lang = lang;
  try {
    me = await api('/api/me');
  } catch (e) {
    return render(h('div', { class: 'card center' }, h('h2', {}, 'Filthy'), h('p', { class: 'muted' }, e.message)));
  }
  const local = (() => { try { return localStorage.getItem('lang'); } catch { return null; } })();
  if (me.user.lang_chosen && !local && me.user.lang !== lang) setLang(me.user.lang, { save: false });
  else if (local && local !== me.user.lang) api('/api/me/lang', { method: 'PUT', body: { lang: local } }).catch(() => {});
  if (!me.user.lang_chosen && !local) openLangPicker(); // first visit: ask once, Russian stays preselected
  // Deep link from the bot: t.me/<bot>?startapp=event_5
  const start = tg?.initDataUnsafe?.start_param;
  if (start && !location.hash) location.hash = start.replace('_', '/');
  route();
})();
