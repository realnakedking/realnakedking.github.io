// Админка «голый король». Работает целиком в браузере: читает и записывает файлы сайта через GitHub.
// Ключ GitHub хранится только в переменной этой вкладки — не в localStorage, не в sessionStorage, не в файлах.
import { CONFIG } from './config.js';
import { GitHub } from './gh.js';
import { pickImage, loadImage, openCropper, makePhotoSet, makeCover, makeIcon } from './images.js';
import { renderHome, renderAbout, renderContact, renderNotFound, setAssetVersion, safeUrl, releaseInfo, THEMES } from '../src/render.mjs';
import { isValidTimeZone } from '../src/tz.mjs';

const PUB = `${CONFIG.owner}/${CONFIG.publicRepo}`;
const PRIV = `${CONFIG.owner}/${CONFIG.privateRepo}`;
const PHOTO_ASPECT = 1520 / 1377;
const ZONES = ['Europe/Moscow', 'Europe/Minsk', 'Europe/Kaliningrad', 'Asia/Jerusalem', 'Europe/Kyiv', 'Asia/Almaty', 'Asia/Yekaterinburg', 'Asia/Novosibirsk', 'Asia/Vladivostok', 'Europe/Berlin', 'Europe/London', 'America/New_York', 'UTC'];
const SECTIONS = [['home', 'Главная'], ['links', 'Ссылки'], ['release', 'Релиз'], ['about', 'About'], ['contact', 'Contact'], ['site', 'Сайт'], ['history', 'История']];

const S = {
  gh: null,
  pub: null,            // снимок публичного хранилища
  priv: null,           // снимок закрытого хранилища (null — недоступно)
  published: null,      // данные, которые сейчас на сайте
  data: null,           // рабочая копия
  savedJson: '',        // что сохранено (черновик или публикация) — для отметки «есть несохранённое»
  blobs: new Map(),     // путь → файл, который есть в этой вкладке (новые фото, значки)
  urls: new Map(),      // путь → временный адрес для показа
  section: 'home',
  open: null,           // какая строка списка раскрыта
  history: null,
  undo: [],             // прежние состояния редактора — для кнопки «Отменить»
  last: '', lastAt: 0,
};

// ---------- Мелкие помощники ----------

const app = document.getElementById('app');
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list' && k !== 'form') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c);
  return el;
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const json = (d) => JSON.stringify(d, null, 2) + '\n';
const newId = () => 'x' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);

function toast(text, bad) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = h('div', { class: 'toast' + (bad ? ' is-bad' : ''), role: 'status' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), bad ? 7000 : 3500);
}
function explain(e) {
  if (e && e.status === 401) return 'Ключ не подошёл или срок его действия закончился. Войдите заново с действующим ключом.';
  if (e && e.status === 403) return 'GitHub отказал в доступе: у ключа не хватает прав или слишком много запросов подряд. ' + (e.detail || '');
  if (e && e.status === 404) return 'GitHub не нашёл хранилище или файл. Проверьте, что ключу открыт доступ к хранилищам сайта.';
  if (e && (e.status === 409 || e.status === 422)) return 'Сайт за это время изменился в другом месте. Сохраните черновик, обновите страницу админки и повторите. ' + (e.detail || '');
  return (e && e.message) || 'Что-то пошло не так.';
}
async function busy(text, fn) {
  const label = h('span', {}, text);
  const el = h('div', { class: 'busy', role: 'alert' }, label);
  document.body.append(el);
  try { return await fn((t) => { label.textContent = t; }); }
  finally { el.remove(); }
}

function normalize(d) {
  d.site ||= {}; d.decor ||= {}; d.home ||= {}; d.release ||= {};
  d.listen = Array.isArray(d.listen) ? d.listen : [];
  d.follow = Array.isArray(d.follow) ? d.follow : [];
  d.about ||= {}; d.about.blocks = Array.isArray(d.about.blocks) ? d.about.blocks : [];
  d.contact ||= {}; d.contact.items = Array.isArray(d.contact.items) ? d.contact.items : [];
  return d;
}

// ---------- Файлы картинок ----------

function photoFiles(ph) {
  if (!ph) return [];
  const ext = ph.format === 'jpg' ? 'jpg' : 'webp';
  const set = ph.base ? (ph.widths || []).map((w) => `${ph.base}-${w}.${ext}`) : [];
  return [...set, ph.fallback].filter(Boolean);
}
// Все файлы из assets/, на которые ссылаются данные.
function refs(d) {
  const out = new Set();
  const add = (p) => { if (typeof p === 'string' && /^assets\/[A-Za-z0-9_\-./]+$/.test(p) && !p.includes('..')) out.add(p); };
  photoFiles(d.home && d.home.photo).forEach(add);
  photoFiles(d.about && d.about.photo).forEach(add);
  const r = d.release || {};
  add(r.cover); add(r.presaveVkIcon); add(r.presaveYandexIcon);
  for (const x of [...(d.listen || []), ...(d.follow || []), ...((d.contact || {}).items || [])]) add(x && x.icon);
  return out;
}
function assetUrl(p) {
  if (!p) return '';
  if (S.blobs.has(p)) {
    if (!S.urls.has(p)) S.urls.set(p, URL.createObjectURL(S.blobs.get(p)));
    return S.urls.get(p);
  }
  return '../' + p;
}
function photoThumb(ph) {
  if (!ph) return '';
  return assetUrl(ph.fallback || photoFiles(ph)[0]);
}
// Подтянуть файлы, которых нет на сайте: из закрытого хранилища (черновик) или из старой версии сайта.
async function fetchMissing(d, from) {
  for (const p of refs(d)) {
    if (S.pub.files.has(p) || S.blobs.has(p)) continue;
    try {
      if (from) S.blobs.set(p, await S.gh.blob(PUB, p, from));
      else if (S.priv && S.priv.files.has(p)) S.blobs.set(p, await S.gh.blob(PRIV, p, S.priv.head));
    } catch { /* файла нет — на его месте будет пусто, это видно в предпросмотре */ }
  }
}

// ---------- Состояние: сохранено / не сохранено ----------

const isDirty = () => json(S.data) !== S.savedJson;
const isUnpublished = () => json(S.data) !== json(S.published);
// Запоминает предыдущее состояние, чтобы его можно было вернуть. Быстрый набор текста — один шаг.
function remember() {
  const now = json(S.data);
  if (now === S.last) return;
  if (!S.undo.length || Date.now() - S.lastAt > 1200) { S.undo.push(S.last); if (S.undo.length > 60) S.undo.shift(); }
  S.last = now; S.lastAt = Date.now();
}
function undo() {
  if (!S.undo.length) return;
  S.data = JSON.parse(S.undo.pop());
  S.last = json(S.data); S.lastAt = 0; S.open = null;
  redraw();
}
function touched() {
  if (S.data) remember();
  const st = document.querySelector('[data-status]');
  if (!st) return;
  const un = document.querySelector('[data-undo]');
  if (un) un.disabled = !S.undo.length;
  const dirty = isDirty(), unpub = isUnpublished();
  st.textContent = dirty ? 'Есть несохранённые изменения' : unpub ? 'Черновик сохранён · на сайте пока старая версия' : 'Изменений нет · на сайте эта версия';
  st.classList.toggle('is-dirty', dirty);
  const save = document.querySelector('[data-save]'), pub = document.querySelector('[data-publish]');
  if (save) save.disabled = !dirty || !S.priv;
  if (pub) pub.disabled = !unpub;
}
window.addEventListener('beforeunload', (e) => { if (S.gh && S.data && isDirty()) { e.preventDefault(); e.returnValue = ''; } });

// ---------- Вход ----------

function loginScreen(message) {
  const user = h('input', { class: 'in', type: 'text', name: 'username', autocomplete: 'username', value: 'naked king site admin', readOnly: true, hidden: true });
  const pass = h('input', { class: 'in', type: 'password', name: 'password', autocomplete: 'current-password', placeholder: 'github_pat_…', autocapitalize: 'off', spellcheck: false, required: true });
  const err = h('p', { class: 'warn', role: 'alert' }, message || '');
  const form = h('form', { class: 'login', autocomplete: 'on', onsubmit: async (e) => {
    e.preventDefault();
    const token = pass.value.trim();
    if (!token) return;
    err.textContent = '';
    try {
      await busy('Проверяю ключ…', async (say) => {
        const gh = new GitHub(token);
        const info = await gh.repo(PUB);
        if (!info.permissions || !info.permissions.push) throw new Error('У этого ключа нет права записи в хранилище сайта.');
        S.gh = gh;
        say('Загружаю данные сайта…');
        await loadAll();
      });
      pass.value = '';
      shell();
    } catch (ex) { S.gh = null; err.textContent = explain(ex); }
  } },
    h('div', {}, h('div', { class: 'login__logo' }, 'голый король'), h('p', { class: 'h' }, 'Панель управления')),
    user,
    h('label', { class: 'f' }, h('span', { class: 'f__l' }, 'Ключ доступа GitHub'), pass),
    err,
    h('button', { class: 'b b--ink', type: 'submit' }, 'Войти'),
    h('p', { class: 'hint' }, 'Ключ никуда не сохраняется: он остаётся только в этой открытой вкладке и стирается, когда вы её закрываете или нажимаете «Выйти». Удобнее всего держать его в «Паролях» на iPhone.'),
  );
  app.replaceChildren(form);
}

async function loadAll() {
  S.pub = await S.gh.snapshot(PUB, CONFIG.branch);
  S.published = normalize(JSON.parse(await S.gh.text(PUB, 'data/site.json', S.pub.head)));
  S.priv = null;
  try { S.priv = await S.gh.snapshot(PRIV, CONFIG.branch); }
  catch (e) {
    if (e.status === 409) S.priv = { head: null, treeSha: null, files: new Map(), empty: true };
    else if (e.status !== 404 && e.status !== 403) throw e;
  }
  S.data = clone(S.published);
  S.savedJson = json(S.published);
  if (S.priv && S.priv.files.has('site.json')) {
    try {
      const draft = normalize(JSON.parse(await S.gh.text(PRIV, 'site.json', S.priv.head)));
      S.data = draft; S.savedJson = json(draft);
    } catch { /* повреждённый черновик не мешает работе: берём опубликованную версию */ }
  }
  await fetchMissing(S.data);
  S.history = null;
  S.undo = []; S.last = json(S.data); S.lastAt = 0;
}

function logout() {
  if (isDirty() && !confirm('Есть несохранённые изменения. Выйти без сохранения?')) return;
  S.gh = null; S.data = null; S.published = null; S.blobs.clear();
  for (const u of S.urls.values()) URL.revokeObjectURL(u);
  S.urls.clear();
  loginScreen();
}

// ---------- Каркас ----------

function shell() {
  const tabs = h('div', { class: 'tabs' }, h('div', { class: 'tabs__in', role: 'tablist' },
    SECTIONS.map(([id, name]) => h('button', { class: 'tab' + (S.section === id ? ' is-on' : ''), type: 'button', role: 'tab', 'data-tab': id, onclick: () => { S.section = id; S.open = null; shell(); window.scrollTo(0, 0); } }, name))));
  const main = h('main', { class: 'wrap' }, h('div', { class: 'sec' }, section()));
  const bar = h('div', { class: 'bar' }, h('div', { class: 'bar__in' },
    h('div', { class: 'bar__top' },
      h('button', { class: 'bar__undo', type: 'button', 'data-undo': '', onclick: undo }, '↶ Отменить'),
      h('div', { class: 'bar__st', 'data-status': '' })),
    h('div', { class: 'row' },
      h('button', { class: 'b b--soft', type: 'button', onclick: () => preview() }, 'Предпросмотр'),
      h('button', { class: 'b', type: 'button', 'data-save': '', onclick: saveDraft }, 'Сохранить черновик'),
      h('button', { class: 'b b--ink', type: 'button', 'data-publish': '', onclick: publish }, 'Опубликовать'))));
  app.replaceChildren(
    h('header', { class: 'top' }, h('div', {}, h('span', { class: 'top__logo' }, 'голый король'), h('span', { class: 'top__sub' }, 'админка')),
      h('button', { class: 'linkbtn', type: 'button', onclick: logout }, 'Выйти')),
    tabs, main, bar);
  const on = tabs.querySelector('.is-on');
  if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'center' });
  touched();
  // Нижняя панель не должна закрывать последние поля: под ними всегда остаётся свободное место.
  main.style.paddingBottom = (bar.offsetHeight + 110) + 'px';
  document.documentElement.style.scrollPaddingBottom = (bar.offsetHeight + 40) + 'px';
}
const redraw = () => { const y = window.scrollY; shell(); window.scrollTo(0, y); };

// ---------- Поля ----------

function field(label, obj, key, o = {}) {
  const input = h(o.area ? 'textarea' : 'input', {
    class: 'in', value: obj[key] ?? '', type: o.area ? null : (o.type || 'text'), rows: o.rows, placeholder: o.ph || '',
    inputMode: o.mode, autocapitalize: o.caps === false ? 'off' : null, spellcheck: o.caps === false ? false : null, maxLength: o.max || (o.area ? 20000 : 300),
    oninput: (e) => { obj[key] = e.target.value; if (o.after) o.after(e.target); touched(); },
    onblur: (e) => { if (o.blur) { o.blur(e.target); touched(); } },
  });
  if (o.check) input.classList.toggle('is-bad', !o.check(input.value));
  return h('label', { class: 'f' }, h('span', { class: 'f__l' }, label), input, o.hint && h('span', { class: 'hint' }, o.hint));
}
// Поле ссылки: дописывает https:// (или mailto: для почты) и подсвечивает некорректный адрес.
function urlField(label, obj, key, o = {}) {
  const ok = (v) => !String(v).trim() || !!safeUrl(v);
  return field(label, obj, key, {
    ...o, type: 'url', mode: 'url', caps: false, ph: o.ph || 'https://', check: ok,
    after: (el) => el.classList.toggle('is-bad', !ok(el.value)),
    blur: (el) => {
      let v = el.value.trim();
      if (v && !/^[a-z][a-z0-9+.-]*:/i.test(v)) v = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(v) ? 'mailto:' + v : 'https://' + v;
      obj[key] = v; el.value = v; el.classList.toggle('is-bad', !ok(v));
    },
  });
}
function toggle(label, value, onchange) {
  return h('label', { class: 'sw' }, h('span', { class: 'sw__t' }, label),
    h('input', { type: 'checkbox', checked: !!value, onchange: (e) => { onchange(e.target.checked); touched(); } }), h('span', { class: 'sw__k' }));
}
function select(label, value, options, onchange, hint) {
  const el = h('select', { class: 'in', onchange: (e) => { onchange(e.target.value); touched(); } },
    options.map(([v, name]) => h('option', { value: v, selected: v === value }, name)));
  return h('label', { class: 'f' }, h('span', { class: 'f__l' }, label), el, hint && h('span', { class: 'hint' }, hint));
}
const sq = (text, title, onclick, disabled) => h('button', { class: 'b b--sq', type: 'button', title, 'aria-label': title, disabled, onclick }, text);
function move(list, i, d) {
  const j = i + d;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  redraw();
}

// ---------- Фото ----------

async function choosePhoto(aspect, title) {
  const file = await pickImage();
  if (!file) return null;
  try {
    const img = await busy('Открываю фото…', () => loadImage(file));
    const rect = await openCropper(img, aspect, title);
    return rect ? { img, rect } : null;
  } catch (e) { toast(explain(e), true); return null; }
}
function photoBlock(title, getPhoto, setPhoto, name, extra) {
  const ph = getPhoto();
  return h('div', { class: 'card' },
    h('div', { class: 'photo' },
      ph ? h('img', { class: 'photo__img', src: photoThumb(ph), alt: '' }) : h('div', { class: 'photo__img' }),
      h('div', { class: 'photo__btns' },
        h('button', { class: 'b', type: 'button', onclick: async () => {
          const pick = await choosePhoto(PHOTO_ASPECT, title);
          if (!pick) return;
          try {
            const made = await busy('Сжимаю фото…', () => makePhotoSet(pick.img, pick.rect, name, (S.data.home.logoText || S.data.site.title || '')));
            for (const [p, b] of made.files) S.blobs.set(p, b);
            setPhoto(made.photo); redraw(); toast('Фото заменено. Посмотрите в предпросмотре.');
          } catch (e) { toast(explain(e), true); }
        } }, ph ? 'Заменить фото' : 'Выбрать фото'),
        extra)),
    h('p', { class: 'hint' }, 'Фото выбирается из галереи, затем кадрируется. Края на сайте плавно растворяются в фон, поэтому лицо лучше держать ближе к центру.'));
}

// ---------- Раздел «Главная» ----------

function secHome() {
  const d = S.data, dec = d.decor;
  const parts = String(dec.coords || '').split(/\s{2,}|　/).filter(Boolean);
  const co = { a: parts[0] || '', b: parts.slice(1).join(' ') };
  const setCo = () => { dec.coords = [co.a.trim(), co.b.trim()].filter(Boolean).join('   '); };
  return [
    h('h2', { class: 'h' }, 'Главное фото'),
    photoBlock('Главное фото', () => d.home.photo, (p) => { d.home.photo = p; }, 'home'),
    h('h2', { class: 'h' }, 'Тексты'),
    h('div', { class: 'card' },
      field('Надпись (логотип)', d.home, 'logoText', { max: 24, hint: 'Крупная надпись поверх фото. Рассчитана на короткое слово.' }),
      field('Заголовок блока площадок', d.home, 'listenLabel', { max: 40 }),
      field('Заголовок блока соцсетей', d.home, 'followLabel', { max: 40 })),
    h('h2', { class: 'h' }, 'Детали оформления'),
    h('div', { class: 'card' },
      toggle('Росчерк на надписи', dec.signature, (v) => { dec.signature = v; }),
      toggle('Крестик вверху', dec.cross, (v) => { dec.cross = v; }),
      toggle('Штрихи по краям', dec.specks, (v) => { dec.specks = v; }),
      field('Надпись вверху слева', dec, 'officialSite', { max: 40, hint: 'Пустое поле — надписи нет.' }),
      field('Координаты: первая строка', co, 'a', { max: 30, after: setCo }),
      field('Координаты: вторая строка', co, 'b', { max: 30, after: setCo, hint: 'Оба поля пустые — координат нет.' })),
  ];
}

// ---------- Раздел «Ссылки» ----------

function iconView(item) {
  if (item.icon) return h('img', { class: 'item__icon', src: assetUrl(item.icon), alt: '' });
  return h('span', { class: 'item__mono' }, String(item.title || item.label || '?').trim().slice(0, 2).toUpperCase());
}
function iconPicker(item) {
  const all = [...new Set([...[...S.pub.files.keys()].filter((p) => /^assets\/icons\/[^/]+\.(svg|png|webp)$/.test(p)), ...[...S.blobs.keys()].filter((p) => p.startsWith('assets/icons/'))])].sort();
  const back = h('div', { class: 'modal', onclick: (e) => { if (e.target === back) back.remove(); } });
  const pick = (p) => { item.icon = p; back.remove(); redraw(); };
  back.append(h('div', { class: 'modal__box' },
    h('h2', { class: 'modal__title' }, 'Значок'),
    h('div', { class: 'icons' },
      h('button', { class: 'icons__b' + (!item.icon ? ' is-on' : ''), type: 'button', onclick: () => pick('') }, 'Без значка'),
      all.map((p) => h('button', { class: 'icons__b' + (item.icon === p ? ' is-on' : ''), type: 'button', title: p.split('/').pop(), onclick: () => pick(p) }, h('img', { src: assetUrl(p), alt: p.split('/').pop() })))),
    h('button', { class: 'b', type: 'button', onclick: async () => {
      const file = await pickImage();
      if (!file) return;
      try {
        const made = await busy('Готовлю значок…', async () => makeIcon(await loadImage(file)));
        S.blobs.set(made.path, made.blob); pick(made.path);
      } catch (e) { toast(explain(e), true); }
    } }, 'Загрузить свой значок'),
    h('p', { class: 'hint' }, 'Свой значок лучше брать чёрным на прозрачном фоне (PNG) — так он совпадёт с остальными. Без значка на кнопке будут первые две буквы названия.'),
    h('button', { class: 'b b--soft', type: 'button', onclick: () => back.remove() }, 'Закрыть')));
  document.body.append(back);
}
function linkList(title, list, kind) {
  return [
    h('h2', { class: 'h' }, title),
    list.map((x, i) => {
      const key = kind + ':' + i, open = S.open === key;
      const bad = String(x.url || '').trim() && !safeUrl(x.url);
      return h('div', { class: 'item' + (x.enabled === false ? ' is-off' : '') },
        h('div', { class: 'item__head' },
          iconView(x),
          h('span', { class: 'item__title' }, x.title || 'Без названия', h('span', { class: 'item__sub' }, x.enabled === false ? 'скрыта' : bad ? 'ссылка с ошибкой — не показывается' : !String(x.url || '').trim() ? 'нет ссылки — не показывается' : x.url)),
          sq('↑', 'Выше', () => move(list, i, -1), i === 0),
          sq('↓', 'Ниже', () => move(list, i, 1), i === list.length - 1),
          sq(open ? '×' : '✎', open ? 'Свернуть' : 'Изменить', () => { S.open = open ? null : key; redraw(); })),
        open && [
          field('Название', x, 'title', { max: 40 }),
          urlField('Ссылка', x, 'url'),
          h('div', { class: 'row' },
            h('button', { class: 'b b--soft', type: 'button', onclick: () => iconPicker(x) }, 'Значок'),
            h('button', { class: 'b b--bad', type: 'button', onclick: () => { if (confirm(`Удалить ссылку «${x.title || ''}»?`)) { list.splice(i, 1); S.open = null; redraw(); } } }, 'Удалить')),
          toggle('Показывать на сайте', x.enabled !== false, (v) => { x.enabled = v; redraw(); }),
        ]);
    }),
    h('button', { class: 'b', type: 'button', onclick: () => { list.push({ id: newId(), title: '', url: '', icon: '', enabled: true }); S.open = kind + ':' + (list.length - 1); redraw(); } }, '+ Добавить ссылку'),
  ];
}
function secLinks() {
  return [
    h('p', { class: 'hint' }, 'Стрелки меняют порядок кнопок. Ссылка появляется на сайте, только если у неё есть название и правильный адрес.'),
    linkList('Музыкальные площадки (Listen)', S.data.listen, 'listen'),
    linkList('Соцсети (Follow)', S.data.follow, 'follow'),
  ];
}

// ---------- Раздел «Релиз» ----------

function releaseNote() {
  const { mode, atMs, hasDate, tz } = releaseInfo(S.data);
  const r = S.data.release;
  if (!String(r.title || '').trim()) return 'Название не заполнено — карточка на сайте не показывается.';
  if (mode === 'hidden') return 'Карточка скрыта. Все данные сохранены, её можно включить обратно.';
  if (mode === 'soon') return 'Вручную включено «Скоро релиз»: карточка не переключится сама.';
  if (mode === 'out') return 'Вручную включено «Latest release»: показывается кнопка «Слушать».';
  if (!hasDate) return 'Дата или время не заполнены — в автоматическом режиме карточка будет показана как вышедший релиз.';
  const fmt = (zone) => new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: zone }).format(new Date(atMs));
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const when = `${fmt(tz)} (${tz})` + (here && here !== tz ? ` — это ${fmt(here)} по времени этого устройства` : '');
  return atMs > Date.now()
    ? `Сейчас: «Скоро релиз» с пресейвами. Карточка сама переключится на «Слушать» ${when}.`
    : `Сейчас: «Latest release» с кнопкой «Слушать». Момент выхода: ${when}.`;
}
function secRelease() {
  const r = S.data.release;
  const note = h('p', { class: 'hint' }, releaseNote());
  const upd = () => { note.textContent = releaseNote(); };
  const zones = [...new Set([r.timezone || 'Europe/Moscow', ...ZONES])].filter(isValidTimeZone);
  return [
    h('div', { class: 'card' },
      select('Режим карточки', ['auto', 'soon', 'out', 'hidden'].includes(r.mode) ? r.mode : 'hidden', [
        ['auto', 'Автоматически: пресейв → «Слушать» в момент выхода'],
        ['soon', 'Вручную: «Скоро релиз» (пресейвы)'],
        ['out', 'Вручную: «Latest release» (кнопка «Слушать»)'],
        ['hidden', 'Скрыть карточку'],
      ], (v) => { r.mode = v; upd(); }),
      note),
    h('h2', { class: 'h' }, 'Релиз'),
    h('div', { class: 'card' },
      h('div', { class: 'photo' },
        r.cover ? h('img', { class: 'photo__img photo__img--sq', src: assetUrl(r.cover), alt: '' }) : h('div', { class: 'photo__img photo__img--sq' }),
        h('div', { class: 'photo__btns' },
          h('button', { class: 'b', type: 'button', onclick: async () => {
            const pick = await choosePhoto(1, 'Обложка релиза');
            if (!pick) return;
            try {
              const made = await busy('Сжимаю обложку…', () => makeCover(pick.img, pick.rect));
              S.blobs.set(made.path, made.blob); r.cover = made.path; redraw();
            } catch (e) { toast(explain(e), true); }
          } }, r.cover ? 'Заменить обложку' : 'Загрузить обложку'),
          r.cover && h('button', { class: 'b b--soft', type: 'button', onclick: () => { r.cover = ''; redraw(); } }, 'Убрать обложку'))),
      field('Название', r, 'title', { max: 80, after: upd }),
      field('Артист', r, 'artist', { max: 60 })),
    h('h2', { class: 'h' }, 'Когда выходит'),
    h('div', { class: 'card' },
      h('div', { class: 'row' },
        field('Дата', r, 'date', { type: 'date', after: upd }),
        field('Время', r, 'time', { type: 'time', after: upd })),
      select('Часовой пояс', r.timezone || 'Europe/Moscow', zones.map((z) => [z, z]), (v) => { r.timezone = v; upd(); }, 'Дата и время считаются в этом поясе. Посетители из любой страны увидят переключение в один и тот же момент.')),
    h('h2', { class: 'h' }, 'До выхода: пресейвы'),
    h('div', { class: 'card' },
      urlField('Пресейв VK Музыка', r, 'presaveVk'),
      urlField('Пресейв Яндекс Музыка', r, 'presaveYandex'),
      h('p', { class: 'hint' }, 'Кнопка пресейва показывается, только если её ссылка заполнена.')),
    h('h2', { class: 'h' }, 'После выхода'),
    h('div', { class: 'card' },
      urlField('Мультиссылка «Слушать»', r, 'listenUrl', { hint: 'Одна готовая ссылка (BandLink, zvonko и т. п.). Её можно добавить заранее: на странице она не показывается до выхода, но файлы сайта открыты, и при желании её можно найти. Если это важно — добавьте ссылку в день релиза.' })),
    h('h2', { class: 'h' }, 'Надписи на карточке'),
    h('div', { class: 'card' },
      h('div', { class: 'row' }, field('Заголовок до выхода', r, 'labelSoon', { max: 40 }), field('Заголовок после', r, 'labelOut', { max: 40 })),
      h('div', { class: 'row' }, field('Строка над названием до', r, 'kickerSoon', { max: 30 }), field('Строка над названием после', r, 'kickerOut', { max: 30 })),
      h('div', { class: 'row' }, field('Текст кнопки «Слушать»', r, 'listenText', { max: 24 })),
      h('div', { class: 'row' }, field('Кнопка пресейва VK', r, 'presaveVkText', { max: 40 }), field('Кнопка пресейва Яндекс', r, 'presaveYandexText', { max: 40 })),
      h('p', { class: 'hint' }, 'Пустая «строка над названием» просто не показывается. К строке «до» на сайте автоматически дописывается дата выхода.')),
  ];
}

// ---------- Раздел «About» ----------

function secAbout() {
  const a = S.data.about;
  const same = json(a.photo || null) === json(S.data.home.photo || null);
  return [
    h('div', { class: 'card' },
      toggle('Страница About включена', a.enabled, (v) => { a.enabled = v; }),
      h('p', { class: 'hint' }, 'Выключенная страница исчезает с сайта вместе со ссылкой на неё. Тексты и фото сохраняются.')),
    h('h2', { class: 'h' }, 'Фото'),
    photoBlock('Фото для About', () => a.photo, (p) => { a.photo = p; }, 'about',
      !same && S.data.home.photo && h('button', { class: 'b b--soft', type: 'button', onclick: () => { a.photo = clone(S.data.home.photo); redraw(); } }, 'Как на главной')),
    h('h2', { class: 'h' }, 'Текст'),
    h('div', { class: 'card' },
      field('Название страницы (в меню)', a, 'title', { max: 24 }),
      field('Крупный заголовок', a, 'heading', { max: 30 }),
      field('Биография', a, 'bio', { area: true, rows: 14, hint: 'Пустая строка — новый абзац. Обычный перенос строки сохраняется. Чтобы выделить слово жирным, поставьте вокруг него две звёздочки: **так**.' })),
    h('h2', { class: 'h' }, 'Дополнительные блоки'),
    a.blocks.map((b, i) => h('div', { class: 'item' },
      h('div', { class: 'item__head' },
        h('span', { class: 'item__title' }, b.title || `Блок ${i + 1}`),
        sq('↑', 'Выше', () => move(a.blocks, i, -1), i === 0),
        sq('↓', 'Ниже', () => move(a.blocks, i, 1), i === a.blocks.length - 1),
        sq('🗑', 'Удалить', () => { if (confirm('Удалить этот блок?')) { a.blocks.splice(i, 1); redraw(); } })),
      field('Заголовок блока', b, 'title', { max: 60 }),
      field('Текст', b, 'text', { area: true, rows: 5 }))),
    h('button', { class: 'b', type: 'button', onclick: () => { a.blocks.push({ title: '', text: '' }); redraw(); } }, '+ Добавить блок'),
  ];
}

// ---------- Раздел «Contact» ----------

function secContact() {
  const c = S.data.contact;
  return [
    h('div', { class: 'card' },
      toggle('Страница Contact включена', c.enabled, (v) => { c.enabled = v; }),
      field('Название страницы (в меню и заголовке)', c, 'title', { max: 24 }),
      field('Подзаголовок', c, 'subtitle', { area: true, rows: 3, max: 400 })),
    h('h2', { class: 'h' }, 'Контакты'),
    c.items.map((x, i) => {
      const key = 'contact:' + i, open = S.open === key;
      return h('div', { class: 'item' },
        h('div', { class: 'item__head' },
          iconView({ icon: x.icon, title: x.label }),
          h('span', { class: 'item__title' }, x.label || 'Без названия', h('span', { class: 'item__sub' }, x.value || x.url || 'пусто — не показывается')),
          sq('↑', 'Выше', () => move(c.items, i, -1), i === 0),
          sq('↓', 'Ниже', () => move(c.items, i, 1), i === c.items.length - 1),
          sq(open ? '×' : '✎', open ? 'Свернуть' : 'Изменить', () => { S.open = open ? null : key; redraw(); })),
        open && [
          field('Название', x, 'label', { max: 40, ph: 'Telegram, Email…' }),
          field('Текст под названием', x, 'value', { max: 120, caps: false, hint: 'Например, адрес почты. Можно оставить пустым — тогда будет только название.' }),
          urlField('Ссылка для кнопки', x, 'url', { hint: 'Для почты достаточно ввести адрес — «mailto:» допишется само.' }),
          field('Текст кнопки', x, 'button', { max: 24, ph: 'Открыть' }),
          h('div', { class: 'row' },
            h('button', { class: 'b b--soft', type: 'button', onclick: () => iconPicker(x) }, 'Значок'),
            h('button', { class: 'b b--bad', type: 'button', onclick: () => { if (confirm(`Удалить контакт «${x.label || ''}»?`)) { c.items.splice(i, 1); S.open = null; redraw(); } } }, 'Удалить')),
        ]);
    }),
    h('button', { class: 'b', type: 'button', onclick: () => { c.items.push({ label: '', value: '', url: '', icon: '', button: 'Открыть' }); S.open = 'contact:' + (c.items.length - 1); redraw(); } }, '+ Добавить контакт'),
  ];
}

// ---------- Раздел «Сайт» ----------

function secSite() {
  const s = S.data.site;
  const theme = Object.hasOwn(THEMES, s.theme) ? s.theme : 'king';
  return [
    h('h2', { class: 'h' }, 'Режим сайта'),
    h('div', { class: 'card' },
      select('Режим', s.mode === 'linktree' ? 'linktree' : 'full', [['full', 'Полный сайт: главная, About, Contact'], ['linktree', 'Только Linktree: одна главная страница']], (v) => { s.mode = v; }),
      h('p', { class: 'hint' }, 'В режиме «Только Linktree» страницы About и Contact скрыты, но их тексты и фото не удаляются. Карточка релиза включается отдельно — во вкладке «Релиз».')),
    h('h2', { class: 'h' }, 'Цвет фона'),
    h('div', { class: 'card' },
      h('div', { class: 'swatches' }, Object.entries(THEMES).map(([id, t]) => {
        const c = h('span', { class: 'swatch__c' }); c.style.background = t.bg;
        return h('button', { class: 'swatch' + (id === theme ? ' is-on' : ''), type: 'button', onclick: () => { s.theme = id; redraw(); } }, c, t.name);
      })),
      h('p', { class: 'hint' }, 'Цвета подобраны так, чтобы светлый текст, значки и фото оставались читаемыми.')),
    h('h2', { class: 'h' }, 'Название и описание'),
    h('div', { class: 'card' },
      field('Название сайта (вкладка браузера, превью ссылки)', s, 'title', { max: 60 }),
      field('Описание (поиск и превью ссылки в мессенджерах)', s, 'description', { area: true, rows: 3, max: 300 })),
    h('h2', { class: 'h' }, 'Резервная копия'),
    h('div', { class: 'card' },
      h('button', { class: 'b', type: 'button', onclick: downloadBackup }, 'Скачать копию'),
      h('button', { class: 'b b--soft', type: 'button', onclick: restoreBackup }, 'Восстановить из файла'),
      h('p', { class: 'hint' }, 'Копия — один файл со всеми текстами, ссылками, настройками и картинками из редактора. При восстановлении она загружается в редактор; на сайт попадёт только после «Опубликовать».')),
    h('h2', { class: 'h' }, 'Отмена'),
    h('div', { class: 'card' },
      h('button', { class: 'b b--bad', type: 'button', disabled: !isUnpublished(), onclick: () => {
        if (!confirm('Вернуть в редактор версию, которая сейчас на сайте? Неопубликованные изменения пропадут.')) return;
        S.data = clone(S.published); redraw(); toast('В редакторе снова версия с сайта.');
      } }, 'Сбросить всё к версии на сайте'),
      h('p', { class: 'hint' }, 'Одно последнее действие отменяет кнопка «↶ Отменить» внизу (её можно нажимать несколько раз подряд). А эта кнопка убирает сразу все неопубликованные изменения.'),
      !S.priv && h('p', { class: 'warn' }, 'Закрытое хранилище черновиков недоступно этому ключу, поэтому «Сохранить черновик» выключено. Публикация работает.')),
  ];
}

// ---------- Резервная копия ----------

function b64(blob) {
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });
}
async function downloadBackup() {
  try {
    const out = await busy('Собираю копию…', async () => {
      const files = {};
      for (const p of refs(S.data)) {
        let blob = S.blobs.get(p);
        if (!blob && S.pub.files.has(p)) blob = await S.gh.blob(PUB, p, S.pub.head);
        if (blob) files[p] = await b64(blob);
      }
      return { format: 'nakedking-site-backup', version: 1, createdAt: new Date().toISOString(), data: S.data, files };
    });
    const day = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' })), download: `nakedking-site-backup-${day}.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  } catch (e) { toast(explain(e), true); }
}
function restoreBackup() {
  const input = h('input', { type: 'file', accept: 'application/json,.json', onchange: async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      if (file.size > 60 * 1024 * 1024) throw new Error('Файл слишком большой для копии сайта.');
      const obj = JSON.parse(await file.text());
      if (!obj || obj.format !== 'nakedking-site-backup' || !obj.data || typeof obj.data !== 'object') throw new Error('Это не файл копии сайта «голый король».');
      if (!confirm('Загрузить эту копию в редактор? Текущие несохранённые изменения пропадут.')) return;
      const need = refs(obj.data);
      for (const [p, dataUrl] of Object.entries(obj.files || {})) {
        if (!need.has(p) || S.pub.files.has(p) || !/^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(String(dataUrl))) continue;
        S.blobs.set(p, await (await fetch(dataUrl)).blob());
      }
      S.data = normalize(clone(obj.data)); S.open = null; redraw();
      toast('Копия загружена в редактор. Проверьте в предпросмотре и опубликуйте.');
    } catch (e) { toast(e instanceof SyntaxError ? 'Файл повреждён: его не удалось прочитать.' : explain(e), true); }
  } });
  input.click();
}

// ---------- Раздел «История» ----------

function secHistory() {
  const box = h('div', { class: 'hist' }, h('p', { class: 'hint' }, 'Загружаю список публикаций…'));
  const fill = () => {
    box.replaceChildren(...(S.history.length ? S.history.map((c, i) => h('div', { class: 'hist__row' },
      h('span', { class: 'hist__t' }, c.commit.message.split('\n')[0],
        h('span', { class: 'hist__d' }, new Intl.DateTimeFormat('ru', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(c.commit.committer.date)) + (i === 0 ? ' · сейчас на сайте' : ''))),
      i > 0 && h('button', { class: 'b b--soft', type: 'button', onclick: () => loadVersion(c.sha) }, 'Открыть'))) : [h('p', { class: 'hint' }, 'Публикаций пока нет.')]));
  };
  if (S.history) fill();
  else S.gh.history(PUB, 'data/site.json', 30).then((list) => { S.history = list; fill(); }).catch((e) => { box.replaceChildren(h('p', { class: 'warn' }, explain(e))); });
  return [
    h('p', { class: 'hint' }, 'Каждая публикация сохраняется. «Открыть» загружает старую версию в редактор: её можно посмотреть в предпросмотре и вернуть на сайт кнопкой «Опубликовать» — это будет новая публикация, история не теряется.'),
    box,
  ];
}
async function loadVersion(sha) {
  if (isDirty() && !confirm('В редакторе есть несохранённые изменения. Заменить их выбранной версией?')) return;
  try {
    await busy('Загружаю версию…', async () => {
      const d = normalize(JSON.parse(await S.gh.text(PUB, 'data/site.json', sha)));
      await fetchMissing(d, sha);
      S.data = d;
    });
    S.section = 'home'; S.open = null; shell(); preview();
  } catch (e) { toast(explain(e), true); }
}

function section() {
  return ({ home: secHome, links: secLinks, release: secRelease, about: secAbout, contact: secContact, site: secSite, history: secHistory })[S.section]();
}

// ---------- Предпросмотр ----------

function previewHtml(page, relState) {
  const d = clone(S.data);
  if (relState !== 'asis' && d.release && d.release.mode !== 'hidden') d.release.mode = relState;
  let html = page === 'about' ? renderAbout(d, { base: '../' }) : page === 'contact' ? renderContact(d, { base: '../' }) : renderHome(d, { base: '../' });
  if (html == null) return null;
  html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n/, '');
  // Новые картинки ещё не на сайте — подставляем их прямо из редактора.
  for (const p of S.blobs.keys()) html = html.split('../' + p).join(assetUrl(p));
  return html;
}
function preview() {
  let page = 'home', rel = 'asis';
  const frame = h('iframe', { class: 'pv__frame', title: 'Предпросмотр сайта' });
  const note = h('div', { class: 'pv__note' }, 'Это предпросмотр. Посетители увидят изменения только после «Опубликовать».');
  const show = () => {
    const html = previewHtml(page, rel);
    frame.srcdoc = html == null
      ? '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="admin.css"><p class="boot">Эта страница сейчас выключена и на сайте не показывается.</p>'
      : html;
  };
  frame.addEventListener('load', () => {
    const doc = frame.contentDocument;
    if (!doc) return;
    doc.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a');
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute('href') || '';
      if (/(^|\/)about\/$/.test(href)) { page = 'about'; pageSel.value = page; show(); }
      else if (/(^|\/)contact\/$/.test(href)) { page = 'contact'; pageSel.value = page; show(); }
      else if (href === '../') { page = 'home'; pageSel.value = page; show(); }
      else { note.textContent = 'Ссылка ведёт на: ' + a.href; }
    }, true);
  });
  const pageSel = h('select', { class: 'in', 'aria-label': 'Страница', onchange: (e) => { page = e.target.value; show(); } },
    [['home', 'Главная'], ['about', 'About'], ['contact', 'Contact']].map(([v, n]) => h('option', { value: v }, n)));
  const relSel = h('select', { class: 'in', 'aria-label': 'Состояние релиза', onchange: (e) => { rel = e.target.value; show(); } },
    [['asis', 'Релиз: как сейчас'], ['soon', 'Релиз: до выхода'], ['out', 'Релиз: после выхода']].map(([v, n]) => h('option', { value: v }, n)));
  const el = h('div', { class: 'pv' },
    h('div', { class: 'pv__bar' }, pageSel, relSel, h('button', { class: 'b b--ink', type: 'button', onclick: () => el.remove() }, 'Закрыть')),
    frame, note);
  if (window.innerWidth >= 900) frame.classList.add('is-wide');
  document.body.append(el);
  show();
}

// ---------- Сохранение черновика ----------

async function saveDraft(silent) {
  if (!S.priv) return false;
  try {
    await busy('Сохраняю черновик…', async () => {
      const text = json(S.data);
      if (S.priv.empty) {
        await S.gh.initFile(PRIV, 'site.json', text, 'Черновик сайта');
        S.priv = await S.gh.snapshot(PRIV, CONFIG.branch);
      }
      const entries = [{ path: 'site.json', text }];
      for (const p of refs(S.data)) if (S.blobs.has(p) && !S.priv.files.has(p)) entries.push({ path: p, blob: S.blobs.get(p) });
      await S.gh.commit(PRIV, CONFIG.branch, S.priv, entries, 'Черновик сайта');
      S.priv = await S.gh.snapshot(PRIV, CONFIG.branch);
      S.savedJson = text;
    });
    touched();
    if (silent !== true) toast('Черновик сохранён. На сайте пока ничего не изменилось.');
    return true;
  } catch (e) { touched(); toast('Черновик не сохранён. ' + explain(e), true); return false; }
}

// ---------- Публикация ----------

function problems(d) {
  const out = [];
  const badLinks = [...d.listen, ...d.follow].filter((x) => x.enabled !== false && (!String(x.title || '').trim() || !safeUrl(x.url)));
  if (badLinks.length) out.push(`Ссылки без названия или с неверным адресом не будут показаны: ${badLinks.map((x) => x.title || 'без названия').join(', ')}.`);
  const r = d.release, info = releaseInfo(d);
  if (info.mode !== 'hidden' && String(r.title || '').trim()) {
    if (info.mode === 'auto' && !info.hasDate) out.push('Релиз в автоматическом режиме, но дата не заполнена: карточка покажется как вышедший релиз.');
    for (const [k, name] of [['presaveVk', 'пресейв VK'], ['presaveYandex', 'пресейв Яндекс'], ['listenUrl', 'мультиссылка']]) if (String(r[k] || '').trim() && !safeUrl(r[k])) out.push(`Релиз: ${name} — неверный адрес, кнопки не будет.`);
    const soon = info.mode === 'soon' || (info.mode === 'auto' && info.hasDate && info.atMs > Date.now());
    if (soon && !safeUrl(r.presaveVk) && !safeUrl(r.presaveYandex)) out.push('Релиз ещё не вышел, а ссылок на пресейв нет: карточка будет без кнопок.');
    if (!soon && !safeUrl(r.listenUrl)) out.push('Релиз вышел, а мультиссылки нет: карточка будет без кнопки «Слушать».');
  }
  for (const p of refs(d)) if (!S.pub.files.has(p) && !S.blobs.has(p)) out.push(`Не найден файл картинки: ${p.split('/').pop()}. На его месте будет пусто.`);
  return out;
}

async function sha1Hex(parts) {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const all = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { all.set(new Uint8Array(p), o); o += p.byteLength; }
  const dig = await crypto.subtle.digest('SHA-1', all);
  return [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// Те же страницы, что собирает src/build.mjs.
async function buildPages(d) {
  const parts = [];
  for (const f of ['assets/css/site.css', 'assets/css/noscript.css', 'assets/js/release.js']) {
    parts.push(await (await S.gh.blob(PUB, f, S.pub.head)).arrayBuffer());
  }
  setAssetVersion((await sha1Hex(parts)).slice(0, 10));
  return [
    ['index.html', renderHome(d, { base: '', index: '' })],
    ['about/index.html', renderAbout(d, { base: '../', index: '' })],
    ['contact/index.html', renderContact(d, { base: '../', index: '' })],
    ['404.html', renderNotFound(d)],
  ];
}

async function publish() {
  const warn = problems(S.data);
  if (!confirm((warn.length ? 'Обратите внимание:\n\n• ' + warn.join('\n• ') + '\n\n' : '') + 'Опубликовать изменения на сайте?')) return;
  let done = false;
  try {
    await busy('Готовлю публикацию…', async (say) => {
      // Сайт мог измениться не из этой вкладки — тогда публиковать поверх нельзя.
      const fresh = await S.gh.snapshot(PUB, CONFIG.branch);
      if (fresh.head !== S.pub.head) { const e = new Error(); e.status = 409; throw e; }
      const d = S.data;
      const entries = [{ path: 'data/site.json', text: json(d) }];
      for (const [path, html] of await buildPages(d)) {
        if (html != null) entries.push({ path, text: html });
        else if (S.pub.files.has(path)) entries.push({ path, remove: true });
      }
      const now = refs(d);
      for (const p of now) if (!S.pub.files.has(p) && S.blobs.has(p)) entries.push({ path: p, blob: S.blobs.get(p) });
      // Загруженные через админку картинки, которые больше нигде не используются, убираются с сайта
      // (в истории версий они остаются, старую публикацию можно вернуть).
      for (const p of refs(S.published)) {
        if (!now.has(p) && S.pub.files.has(p) && /^assets\/(img\/|icons\/custom-)/.test(p)) entries.push({ path: p, remove: true });
      }
      await S.gh.commit(PUB, CONFIG.branch, S.pub, entries, 'Публикация из админки: ' + new Intl.DateTimeFormat('ru', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow' }).format(new Date()) + ' МСК', (i, n) => say(`Отправляю файлы: ${i} из ${n}…`));
      done = true;
      say('Обновляю данные…');
      S.published = clone(d);
      S.pub = await S.gh.snapshot(PUB, CONFIG.branch);
      S.history = null;
    });
  } catch (e) {
    if (!done) { toast('Не опубликовано, сайт остался прежним. ' + explain(e), true); touched(); return; }
  }
  if (S.priv) await saveDraft(true); else S.savedJson = json(S.data);
  redraw();
  toast('Опубликовано. Посетители увидят изменения через 1–10 минут.');
}

loginScreen();
