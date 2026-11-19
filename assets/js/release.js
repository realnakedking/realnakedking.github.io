/* Карточка релиза: «Скоро» → «Новый релиз» в заданный момент.
   Момент выхода хранится как точное мировое время, поэтому часовой пояс
   посетителя не важен. Часы устройства сверяются с часами сервера. */
(function () {
  'use strict';
  var el = document.querySelector('[data-release]');
  if (!el) return;

  function show(state) {
    el.setAttribute('data-show', state);
    el.classList.remove('is-pending');
  }

  var at = Date.parse(el.getAttribute('data-at') || '');
  if (el.getAttribute('data-mode') !== 'auto' || isNaN(at)) {
    show(el.getAttribute('data-show') === 'soon' ? 'soon' : 'out');
    return;
  }

  var WINDOW = 48 * 3600 * 1000;      // «релиз близко»: меньше двух суток до или после
  var MAX_TIMER = 2147000000;         // предел таймера браузера (~24 дня)
  var ping = el.getAttribute('data-ping');
  var offset = 0;                     // поправка: время сервера минус время устройства
  var baseWall, basePerf, timer = null, fallback = null, syncing = false, lastSync = 0;

  function rebase() { baseWall = Date.now(); basePerf = performance.now(); }
  // Текущее время: отсчёт по внутреннему секундомеру браузера плюс поправка.
  function now() { return baseWall + (performance.now() - basePerf) + offset; }

  function apply() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (fallback) { clearTimeout(fallback); fallback = null; }
    var left = at - now();
    if (left <= 0) { show('out'); return; }
    show('soon');
    timer = setTimeout(apply, Math.min(left + 30, MAX_TIMER));
  }

  function sync() {
    if (!ping || !window.fetch || syncing) return;
    if (now() - at > WINDOW) return;             // релиз вышел давно — сверка уже ни на что не влияет
    syncing = true;
    var t0 = Date.now(), p0 = performance.now();
    fetch(ping + '?t=' + t0 + '-' + Math.floor(Math.random() * 1e6), { method: 'HEAD', cache: 'no-store' })
      .then(function (res) {
        var date = res.headers.get('date');
        var server = date ? Date.parse(date) : NaN;
        if (isNaN(server)) return;
        var age = parseInt(res.headers.get('age') || '0', 10);
        if (age > 0) server += age * 1000;       // ответ пришёл из кэша: прибавляем его возраст
        server += 500;                            // сервер округляет время до секунды вниз
        var rt = performance.now() - p0;
        if (rt > 8000) return;                    // слишком медленный ответ — поправке не доверяем
        offset = server - (t0 + rt / 2);
        lastSync = Date.now();
        rebase();
        apply();
      })
      .catch(function () { /* нет сети — остаёмся на часах устройства */ })
      .then(function () { syncing = false; if (el.classList.contains('is-pending')) apply(); });
  }

  rebase();
  if (ping && window.fetch && Math.abs(at - now()) <= WINDOW) {
    // Релиз близко: сначала сверяем часы, чтобы не показать неверное состояние
    // на устройстве с неправильным временем. Ждём ответа не дольше 1,5 секунды.
    fallback = setTimeout(apply, 1500);
  } else {
    apply();
  }
  sync();

  // После возврата на вкладку таймеры могли «уснуть» — пересчитываем и сверяемся заново.
  function wake() {
    rebase();
    apply();
    if (Date.now() - lastSync > 60000) sync();
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) wake(); });
  window.addEventListener('pageshow', function (e) { if (e.persisted) wake(); });
})();
