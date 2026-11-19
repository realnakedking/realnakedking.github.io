// Работа с датой релиза и часовыми поясами. Без внешних библиотек:
// используется база часовых поясов, встроенная в браузер и Node (Intl).

function partsIn(tz, ms) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o;
}

// Смещение пояса (мс) в данный момент: местное время минус UTC.
function offsetAt(tz, ms) {
  const p = partsIn(tz, ms);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

export function isValidTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// «2026-11-20» + «00:00» в поясе tz → точный момент времени (мс от 1970, UTC).
export function zonedToUtcMs(date, time, tz) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  const t = /^(\d{1,2}):(\d{2})$/.exec(time || '00:00');
  if (!d || !t || !isValidTimeZone(tz)) return NaN;
  const wall = Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2], 0);
  // Два прохода: смещение зависит от момента (переход на летнее время).
  let ms = wall - offsetAt(tz, wall);
  ms = wall - offsetAt(tz, ms);
  return ms;
}

// «20 ноября» — день и месяц в поясе релиза.
export function formatDay(ms, tz, lang = 'ru') {
  return new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'long', timeZone: tz }).format(new Date(ms));
}
