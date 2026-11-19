// Фотографии: выбор из галереи, кадрирование и сжатие прямо в браузере.
// Файл всегда перекодируется заново, поэтому в хранилище попадает только сама картинка
// (без геометки и прочих данных съёмки) и только в форматах jpg, webp, png.

const MAX_INPUT = 30 * 1024 * 1024;
const OK_TYPES = /^image\/(jpeg|png|webp|heic|heif)$/;

export function pickImage() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    // Без HEIC в списке iPhone сам отдаёт фото из галереи в JPG.
    input.accept = 'image/jpeg,image/png,image/webp';
    input.addEventListener('change', () => resolve(input.files && input.files[0] ? input.files[0] : null));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

export async function loadImage(file) {
  if (!file) throw new Error('Файл не выбран.');
  if (file.type && !OK_TYPES.test(file.type)) throw new Error('Подходят только фотографии: JPG, PNG, WebP или HEIC.');
  if (file.size > MAX_INPUT) throw new Error('Файл больше 30 МБ. Выберите фото поменьше.');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('пусто');
    if (img.naturalWidth * img.naturalHeight > 60e6) throw new Error('Слишком большое фото (больше 60 мегапикселей).');
    return img;
  } catch (e) {
    URL.revokeObjectURL(url);
    throw new Error(/мегапикс/.test(e.message) ? e.message : 'Не получилось открыть этот файл как фотографию.');
  }
}

function toBlob(canvas, type, q) {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Не удалось сжать фото.'))), type, q));
}

let webp = null;
// Safari на iPhone может не уметь сохранять webp — тогда фото сохраняются в jpg.
export async function canWebp() {
  if (webp !== null) return webp;
  try {
    const c = document.createElement('canvas'); c.width = c.height = 2;
    webp = (await toBlob(c, 'image/webp', 0.8)).type === 'image/webp';
  } catch { webp = false; }
  return webp;
}

function draw(img, rect, w, h, bg) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h); }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);
  return c;
}

const stamp = () => Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36).padStart(2, '0');

// Большая фотография (главная, About): три ширины + запасной jpg.
export async function makePhotoSet(img, rect, name, alt) {
  const ratio = 1377 / 1520;
  const base = `assets/img/${name}-${stamp()}`;
  const widths = [720, 1040, 1520];
  const useWebp = await canWebp();
  const files = new Map();
  for (const w of widths) {
    const c = draw(img, rect, w, Math.round(w * ratio), '#e7e7e6');
    if (useWebp) files.set(`${base}-${w}.webp`, await toBlob(c, 'image/webp', 0.82));
    if (!useWebp || w === 1040) files.set(`${base}-${w}.jpg`, await toBlob(c, 'image/jpeg', 0.84));
  }
  return {
    photo: { base, widths, format: useWebp ? 'webp' : 'jpg', width: 1520, height: 1377, fallback: `${base}-1040.jpg`, alt: alt || '' },
    files,
  };
}

// Обложка релиза: квадрат 600×600.
export async function makeCover(img, rect) {
  const useWebp = await canWebp();
  const c = draw(img, rect, 600, 600, '#1b1b1b');
  const path = `assets/img/cover-${stamp()}.${useWebp ? 'webp' : 'jpg'}`;
  return { path, blob: await toBlob(c, useWebp ? 'image/webp' : 'image/jpeg', 0.86) };
}

// Свой значок: вписывается в квадрат 96×96, прозрачность сохраняется.
export async function makeIcon(img) {
  const s = 96, k = Math.min(s / img.naturalWidth, s / img.naturalHeight);
  const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
  const c = document.createElement('canvas'); c.width = c.height = s;
  const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (s - w) / 2, (s - h) / 2, w, h);
  return { path: `assets/icons/custom-${stamp()}.png`, blob: await toBlob(c, 'image/png') };
}

// Окно кадрирования: фото двигается пальцем, масштаб — ползунком. Возвращает выбранную область или null.
export function openCropper(img, aspect, title) {
  return new Promise((resolve) => {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
    const back = el('div', 'modal');
    const box = el('div', 'modal__box');
    const head = el('h2', 'modal__title', title);
    const hint = el('p', 'hint', 'Двигайте фото пальцем. Ползунок меняет масштаб.');
    const frame = el('div', 'crop');
    const canvas = el('canvas', 'crop__canvas');
    const zoom = el('input', 'crop__zoom');
    zoom.type = 'range'; zoom.min = '1'; zoom.max = '4'; zoom.step = '0.01'; zoom.value = '1';
    zoom.setAttribute('aria-label', 'Масштаб');
    const row = el('div', 'row');
    const cancel = el('button', 'b', 'Отмена'); cancel.type = 'button';
    const ok = el('button', 'b b--ink', 'Готово'); ok.type = 'button';
    row.append(cancel, ok); frame.append(canvas); box.append(head, hint, frame, zoom, row); back.append(box);
    document.body.append(back);

    const fw = Math.min(frame.clientWidth || 300, 520);
    const fh = Math.round(fw / aspect);
    frame.style.height = fh + 'px';
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(fw * dpr); canvas.height = Math.round(fh * dpr);
    const ctx = canvas.getContext('2d');
    const k0 = Math.max(fw / iw, fh / ih);
    let z = 1, cx = iw / 2, cy = ih / 2;

    function rect() {
      const k = k0 * z, w = fw / k, h = fh / k;
      cx = Math.min(Math.max(cx, w / 2), iw - w / 2);
      cy = Math.min(Math.max(cy, h / 2), ih - h / 2);
      return { x: cx - w / 2, y: cy - h / 2, w, h };
    }
    function paint() {
      const r = rect();
      ctx.fillStyle = '#ddd'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, canvas.width, canvas.height);
    }
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const k = k0 * z;
      cx -= (e.clientX - drag.x) / k; cy -= (e.clientY - drag.y) / k;
      drag = { x: e.clientX, y: e.clientY };
      paint();
    });
    const stop = () => { drag = null; };
    canvas.addEventListener('pointerup', stop); canvas.addEventListener('pointercancel', stop);
    zoom.addEventListener('input', () => { z = Number(zoom.value) || 1; paint(); });
    const done = (v) => { back.remove(); resolve(v); };
    cancel.addEventListener('click', () => done(null));
    ok.addEventListener('click', () => done(rect()));
    paint();
  });
}
