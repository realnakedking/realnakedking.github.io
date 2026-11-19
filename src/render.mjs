// Шаблоны страниц «голый король». Чистые функции: данные сайта → готовый HTML.
// Один и тот же код используется при сборке и (позже) в админке для
// предпросмотра и публикации, поэтому здесь нет ничего, кроме строк.

import { zonedToUtcMs, formatDay } from './tz.mjs';

// Метка версии оформления и скриптов. Она дописывается к адресам site.css и release.js,
// чтобы после публикации телефон не показывал новую страницу со старым оформлением из кэша.
let assetVersion = '';
export function setAssetVersion(v) { assetVersion = v ? `?v=${String(v).replace(/[^A-Za-z0-9]/g, '')}` : ''; }

// Предусмотренные цвета оформления: фон страницы. Сами цвета заданы в site.css, здесь — названия для админки
// и цвет верхней полосы браузера.
export const THEMES = {
  king: { name: 'Чёрный (основной)', bg: '#080808' },
};
const themeOf = (site) => (Object.hasOwn(THEMES, site.theme) ? site.theme : 'king');

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const SAFE_PROTOCOLS = ['http:', 'https:', 'mailto:', 'tel:', 'tg:'];
// Пропускает только обычные ссылки; всё остальное (javascript:, data: и т.п.) отбрасывается.
export function safeUrl(url) {
  const s = String(url ?? '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    return SAFE_PROTOCOLS.includes(u.protocol) ? u.href : '';
  } catch { return ''; }
}

// Путь к файлу сайта: только относительные пути внутри assets/.
function assetPath(p) {
  const s = String(p ?? '').trim();
  return /^assets\/[A-Za-z0-9_\-./]+$/.test(s) && !s.includes('..') ? s : '';
}

const ARROW = '<svg class="arrow" aria-hidden="true" width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2 9 9 2M3.5 2H9v5.5"/></svg>';
const CROSS = '<svg class="topline__cross" aria-hidden="true" width="10" height="18" viewBox="0 0 10 18" fill="none" stroke="currentColor" stroke-width="1"><path d="M5 0v18M1 5h8"/></svg>';
const SPECKS = '<svg class="specks" aria-hidden="true" viewBox="0 0 390 1000" preserveAspectRatio="none" fill="none" stroke="currentColor" stroke-width="0.6" stroke-linecap="round"><path d="M3 96v14M5 101v5M2 118h4M6 240v9M3 246v3M384 92v11M387 99v4M385 268v7M2 520v6M5 523v2M387 610v10M384 615v3M4 880v8M386 940v6M70 3h9M74 5h3M300 2h12M306 5h4M120 996h8M260 997h6"/></svg>';

function extAttrs(url) {
  return /^https?:/.test(url) ? ' target="_blank" rel="noopener"' : '';
}

function iconHtml(item, base, cls = 'btn__icon') {
  const p = assetPath(item.icon);
  if (p) return `<img draggable="false" class="${cls}" src="${base}${esc(p)}" alt="" width="24" height="24" decoding="async">`;
  const mono = String(item.title ?? '').trim().slice(0, 2).toUpperCase();
  return `<span class="${cls} ${cls}--mono" aria-hidden="true">${esc(mono)}</span>`;
}

function visibleLinks(list) {
  return (Array.isArray(list) ? list : [])
    .filter((x) => x && x.enabled !== false)
    .map((x) => ({ ...x, href: safeUrl(x.url) }))
    .filter((x) => x.href && String(x.title ?? '').trim());
}

// Файлы фотографии: набор ширин в формате webp (с запасным jpg) либо целиком в jpg
// (так сохраняет фото админка на устройствах, которые не умеют делать webp).
function photoSet(photo, base) {
  if (!photo) return null;
  const b = assetPath(photo.base);
  const widths = (photo.widths || []).filter((w) => Number.isInteger(w));
  const fallback = assetPath(photo.fallback);
  if (!b || !widths.length) return fallback ? { src: `${base}${fallback}` } : null;
  const ext = photo.format === 'jpg' ? 'jpg' : 'webp';
  return {
    ext,
    srcset: widths.map((w) => `${base}${b}-${w}.${ext} ${w}w`).join(', '),
    src: fallback ? `${base}${fallback}` : `${base}${b}-${widths[0]}.${ext}`,
  };
}

function pictureHtml(photo, base, cls, sizes, eager) {
  const set = photoSet(photo, base);
  if (!set) return '';
  if (!set.srcset) return `<img draggable="false" class="${cls}" src="${esc(set.src)}" alt="${esc(photo.alt)}">`;
  const dims = photo.width && photo.height ? ` width="${+photo.width}" height="${+photo.height}"` : '';
  const load = eager ? ' fetchpriority="high" decoding="async"' : ' loading="lazy" decoding="async"';
  if (set.ext === 'jpg') {
    return `<img draggable="false" class="${cls}" srcset="${esc(set.srcset)}" sizes="${esc(sizes)}" src="${esc(set.src)}" alt="${esc(photo.alt)}"${dims}${load}>`;
  }
  return `<picture><source type="image/webp" srcset="${esc(set.srcset)}" sizes="${esc(sizes)}"><img draggable="false" class="${cls}" src="${esc(set.src)}" alt="${esc(photo.alt)}"${dims}${load}></picture>`;
}

function head(data, base, { title, description, path, preloadHero }) {
  const site = data.site || {};
  const siteUrl = safeUrl(site.url);
  const canonical = siteUrl ? siteUrl + path : '';
  const og = siteUrl ? siteUrl + 'assets/img/og.jpg' : '';
  return `<!doctype html>
<html lang="${esc(site.lang || 'ru')}" data-theme="${themeOf(site)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="strict-origin-when-cross-origin">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="${THEMES[themeOf(site)].bg}">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(site.title || '')}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
${canonical ? `<meta property="og:url" content="${esc(canonical)}">` : ''}
${og ? `<meta property="og:image" content="${esc(og)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${esc(og)}">` : ''}
<link rel="icon" href="${base}favicon.ico" sizes="32x32">
<link rel="apple-touch-icon" href="${base}assets/img/apple-touch-icon.png">
<link rel="preload" href="${base}assets/fonts/anton-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="${base}assets/fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin>
${preloadHero || ''}<link rel="stylesheet" href="${base}assets/css/site.css${assetVersion}">
<noscript><link rel="stylesheet" href="${base}assets/css/noscript.css${assetVersion}"></noscript>
</head>`;
}

function topline(data) {
  const d = data.decor || {};
  const left = String(d.officialSite ?? '').trim();
  const right = String(d.coords ?? '').trim();
  if (!left && !right && !d.cross) return '';
  return `<div class="topline">
<span class="topline__side">${esc(left)}</span>
${d.cross ? CROSS : '<span></span>'}
<span class="topline__side topline__side--right">${right.split(/\s{2,}|\u3000/).filter(Boolean).map((part) => `<span class="topline__part">${esc(part)}</span>`).join('')}</span>
</div>`;
}

function pagesEnabled(data) {
  const full = (data.site || {}).mode !== 'linktree';
  return {
    about: full && !!(data.about && data.about.enabled),
    contact: full && !!(data.contact && data.contact.enabled),
  };
}

function navHtml(items) {
  if (!items.length) return '';
  const parts = [];
  items.forEach((it, i) => {
    if (i) parts.push('<span class="nav__sep" aria-hidden="true"></span>');
    parts.push(`<a class="nav__link" href="${esc(it.href)}">${esc(it.text)}</a>`);
  });
  return `<nav class="nav" aria-label="Разделы сайта">${parts.join('')}</nav>`;
}

// ---------- Карточка релиза ----------

export function releaseInfo(data) {
  const r = data.release || {};
  const mode = ['auto', 'soon', 'out', 'hidden'].includes(r.mode) ? r.mode : 'hidden';
  const tz = r.timezone || 'Europe/Moscow';
  const atMs = zonedToUtcMs(r.date, r.time, tz);
  return { r, mode, tz, atMs, hasDate: Number.isFinite(atMs) };
}

function releaseHtml(data, base, nowMs) {
  const { r, mode, tz, atMs, hasDate } = releaseInfo(data);
  const title = String(r.title ?? '').trim();
  if (mode === 'hidden' || !title) return '';
  // Автоматический режим без корректной даты работать не может — показываем как вышедший.
  const auto = mode === 'auto' && hasDate;
  const initial = mode === 'soon' ? 'soon' : mode === 'out' ? 'out' : (auto && nowMs < atMs ? 'soon' : 'out');

  const cover = assetPath(r.cover);
  const coverHtml = cover
    ? `<img draggable="false" class="release__cover" src="${base}${esc(cover)}" alt="Обложка: ${esc(title)}" width="152" height="152" loading="lazy" decoding="async">`
    : '<span class="release__cover release__cover--empty" aria-hidden="true">Обложка<br>релиза</span>';

  const vk = safeUrl(r.presaveVk);
  const ya = safeUrl(r.presaveYandex);
  const listen = safeUrl(r.listenUrl);
  const day = hasDate ? formatDay(atMs, tz, (data.site || {}).lang || 'ru') : '';

  const presave = [
    vk && `<a class="btn btn--ink" href="${esc(vk)}"${extAttrs(vk)}>${iconHtml({ icon: r.presaveVkIcon, title: 'VK' }, base)}<span class="btn__text">${esc(r.presaveVkText || 'Пресейв VK Музыка')}</span>${ARROW}</a>`,
    ya && `<a class="btn btn--ink" href="${esc(ya)}"${extAttrs(ya)}>${iconHtml({ icon: r.presaveYandexIcon, title: 'ЯМ' }, base)}<span class="btn__text">${esc(r.presaveYandexText || 'Пресейв Яндекс Музыка')}</span>${ARROW}</a>`,
  ].filter(Boolean);

  const kickerSoon = [r.kickerSoon || 'Скоро', day].filter(Boolean).join(' · ');
  // Надпись над названием вышедшего релиза. Пустая — строки нет (заголовок блока уже говорит «Latest release»).
  const kickerOut = String(r.kickerOut ?? '').trim();
  const attrs = auto
    ? ` data-mode="auto" data-at="${new Date(atMs).toISOString()}" data-ping="${base}ping.txt"`
    : ` data-mode="${initial}"`;

  return `<section class="release${auto ? ' is-pending' : ''}" data-release data-show="${initial}"${attrs}>
<h2 class="label"><span data-state="soon">${esc(r.labelSoon || 'Скоро релиз')}</span><span data-state="out">${esc(r.labelOut || 'Latest release')}</span></h2>
<div class="release__card">
${coverHtml}
<div class="release__meta">
${kickerOut ? `<p class="kicker"><span data-state="soon">${esc(kickerSoon)}</span><span data-state="out">${esc(kickerOut)}</span></p>` : `<p class="kicker" data-state="soon">${esc(kickerSoon)}</p>`}
<p class="release__title">${esc(title)}</p>
<p class="kicker">${esc(r.artist || '')}</p>
</div>
${listen ? `<a class="pill release__listen" data-state="out" href="${esc(listen)}"${extAttrs(listen)}>${esc(r.listenText || 'Слушать')} ${ARROW}</a>` : ''}
${presave.length ? `<div class="release__presave cols-${presave.length}" data-state="soon">${presave.join('')}</div>` : ''}
</div>
</section>
<script src="${base}assets/js/release.js${assetVersion}"></script>`;
}

// ---------- Главная ----------

export function renderHome(data, { base = '', nowMs = Date.now(), index = '' } = {}) {
  const site = data.site || {};
  const home = data.home || {};
  const d = data.decor || {};
  const en = pagesEnabled(data);
  const listen = visibleLinks(data.listen);
  const follow = visibleLinks(data.follow);
  const photo = home.photo;
  const heroSet = photoSet(photo, base);
  const preloadHero = heroSet && heroSet.srcset
    ? `<link rel="preload" as="image" type="image/${heroSet.ext === 'jpg' ? 'jpeg' : 'webp'}" imagesrcset="${esc(heroSet.srcset)}" imagesizes="(min-width: 900px) 700px, (min-width: 460px) 530px, 115vw">\n`
    : '';

  const btn = (x, extra = '') => `<a class="btn${extra}" href="${esc(x.href)}"${extAttrs(x.href)}>${iconHtml(x, base)}<span class="btn__text">${esc(x.title)}</span>${ARROW}</a>`;
  const logo = String(home.logoText ?? '').trim() || site.title || '';

  const nav = navHtml([
    en.about && { href: `${base}about/${index}`, text: (data.about.title || 'About') },
    en.contact && { href: `${base}contact/${index}`, text: (data.contact.title || 'Contact') },
  ].filter(Boolean));

  return `${head(data, base, { title: site.title || logo, description: site.description || '', path: '', preloadHero })}
<body class="page-home">
<div class="page">
${d.specks ? SPECKS : ''}
${topline(data)}
<main class="home">
<div class="hero">
${pictureHtml(photo, base, 'hero__photo', '(min-width: 900px) 700px, (min-width: 460px) 530px, 115vw', true)}
<h1 class="hero__title">${esc(logo)}${d.signature ? `<img draggable="false" class="hero__sig" src="${base}assets/img/signature.webp" alt="" width="720" height="326" decoding="async">` : ''}</h1>
</div>
<div class="sections">
${listen.length ? `<section>
<h2 class="label">${esc(home.listenLabel || 'Listen')}</h2>
<div class="links links--listen">${listen.map((x) => btn(x)).join('')}</div>
</section>` : ''}
${follow.length ? `<section>
<h2 class="label">${esc(home.followLabel || 'Follow')}</h2>
<div class="links links--follow cols-${Math.min(follow.length, 5)}">${follow.map((x) => btn(x, ' btn--follow')).join('')}</div>
</section>` : ''}
${releaseHtml(data, base, nowMs)}
</div>
</main>
<footer class="footer">${nav}</footer>
</div>
</body>
</html>
`;
}

// ---------- About и Contact ----------

function subTop(data, base, label, index = '') {
  const logo = String((data.home || {}).logoText ?? '').trim() || (data.site || {}).title || '';
  return `<div class="subtop">
<a class="subtop__back" href="${base}${index}"><span aria-hidden="true">←</span> ${esc(logo)}</a>
<span class="subtop__label">${esc(label)}</span>
</div>`;
}

// Текст → абзацы. Пустая строка разделяет абзацы, одиночный перенос сохраняется.
// Выделение: **так** (полужирным). Весь остальной текст экранируется.
function inline(text) {
  return esc(text).replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
}
function paragraphs(text) {
  return String(text ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p>${inline(p).replace(/\n/g, '<br>')}</p>`).join('\n');
}

export function renderAbout(data, { base = '../', index = '' } = {}) {
  const site = data.site || {};
  const a = data.about || {};
  const en = pagesEnabled(data);
  if (!en.about) return null;
  const title = a.title || 'About';
  const blocks = (Array.isArray(a.blocks) ? a.blocks : [])
    .filter((b) => b && (String(b.title ?? '').trim() || String(b.text ?? '').trim()));
  const nav = navHtml([
    { href: base + index, text: 'Home' },
    en.contact && { href: `${base}contact/${index}`, text: (data.contact.title || 'Contact') },
  ].filter(Boolean));
  return `${head(data, base, { title: `${title} — ${site.title || ''}`, description: site.description || '', path: 'about/' })}
<body class="page-sub">
<div class="page">
${subTop(data, base, title, index)}
<main class="sub sub--about">
<div class="sub__photo">${pictureHtml(a.photo, base, 'hero__photo', '(min-width: 900px) 520px, 100vw', true)}</div>
<div class="sub__body">
<h1 class="sub__title">${esc(String(a.heading ?? '').trim() || title)}</h1>
<div class="prose">${paragraphs(a.bio)}</div>
${blocks.map((b) => `<div class="block">
${String(b.title ?? '').trim() ? `<h2 class="label">${esc(b.title)}</h2>` : ''}
<div class="prose">${paragraphs(b.text)}</div>
</div>`).join('\n')}
</div>
</main>
<footer class="footer">${nav}</footer>
</div>
</body>
</html>
`;
}

export function renderContact(data, { base = '../', index = '' } = {}) {
  const site = data.site || {};
  const c = data.contact || {};
  const en = pagesEnabled(data);
  if (!en.contact) return null;
  const title = c.title || 'Contact';
  // Блок показывается, если у него есть контакт или ссылка.
  const items = (Array.isArray(c.items) ? c.items : [])
    .filter((x) => x && (String(x.value ?? '').trim() || safeUrl(x.url)));
  const row = (x) => {
    const href = safeUrl(x.url);
    const value = String(x.value ?? '').trim();
    // Без контакта в блоке остаётся только название площадки.
    const text = value
      ? `<p class="kicker">${esc(x.label)}</p><p class="card__value">${esc(value)}</p>`
      : `<p class="card__value">${esc(x.label)}</p>`;
    const button = String(x.button ?? '').trim() || (href.startsWith('mailto:') ? 'Написать' : 'Открыть');
    return `<div class="card">
${iconHtml({ icon: x.icon, title: x.label }, base, 'card__icon')}
<div class="card__text">${text}</div>
${href ? `<a class="pill card__action" href="${esc(href)}"${extAttrs(href)} aria-label="${esc(button)}: ${esc(x.label)}">${esc(button)} ${ARROW}</a>` : ''}
</div>`;
  };
  const lead = String(c.subtitle ?? '').trim();
  const nav = navHtml([
    { href: base + index, text: 'Home' },
    en.about && { href: `${base}about/${index}`, text: (data.about.title || 'About') },
  ].filter(Boolean));
  return `${head(data, base, { title: `${title} — ${site.title || ''}`, description: site.description || '', path: 'contact/' })}
<body class="page-sub">
<div class="page">
${subTop(data, base, title, index)}
<main class="sub sub--contact">
<div class="sub__body">
<h1 class="sub__title">${esc(title)}</h1>
${lead ? `<p class="sub__lead">${esc(lead)}</p>` : ''}
<div class="cards">${items.map(row).join('\n')}</div>
</div>
</main>
<footer class="footer">${nav}</footer>
</div>
</body>
</html>
`;
}

export function renderNotFound(data) {
  const site = data.site || {};
  // Страница 404 открывается по любому адресу, поэтому пути здесь от корня сайта.
  return `${head(data, '/', { title: `Страница не найдена — ${site.title || ''}`, description: '', path: '' })
    .replace('<meta property="og:type"', '<meta name="robots" content="noindex">\n<meta property="og:type"')}
<body class="page-sub">
<div class="page">
<main class="sub sub--contact">
<div class="sub__body">
<h1 class="sub__title">404</h1>
<div class="prose"><p>Такой страницы нет.</p></div>
<div class="contact"><a class="contact__row" href="/"><span class="contact__key">Home</span><span class="contact__val">${esc(site.title || '')}</span>${ARROW}</a></div>
</div>
</main>
</div>
</body>
</html>
`;
}
