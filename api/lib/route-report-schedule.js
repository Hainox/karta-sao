// Планировщик периодического отчёта по отрисовке маршрутов ОДХ.
//
// Вынесен из server.js отдельным модулем: server.js на верхнем уровне открывает
// пул к базе и слушает порт, поэтому его нельзя импортировать в тест. Здесь — только
// арифметика расписания и включение по флагу, без базы, сети и HTTP.

/** Интервал между отправками: ровно три часа. */
export const ROUTE_REPORT_INTERVAL_MS = 3 * 60 * 60 * 1000;

/**
 * Задержка до ближайшей границы трёхчасового интервала, считая от эпохи.
 * Эпоха кратна трём часам, поэтому отправки всегда приходятся на 00:00, 03:00,
 * 06:00… и в МСК (UTC+3) тоже ложатся на целые часы.
 */
export function delayUntilNextTick(now = Date.now(), intervalMs = ROUTE_REPORT_INTERVAL_MS) {
  return intervalMs - (now % intervalMs);
}

/**
 * Включение отчёта: по умолчанию выключено, расписание поднимает только явное
 * «true» (без учёта регистра). Значения 1, yes, on расписанием не считаются.
 */
export function routeReportEnabled(env = process.env) {
  return String(env?.ODH_ROUTE_REPORT_ENABLED || '').toLowerCase() === 'true';
}

/**
 * Поднимает расписание отчёта. Возвращает ручку остановки.
 *
 * Следующий запуск планируется только после завершения текущего, поэтому два
 * отчёта не наложатся и расписание не сдвоится. Сбой одного запуска (в том числе
 * отказ самого обработчика ошибки) гасится внутри и не срывает следующую отправку.
 * Таймер снимают с учёта unref, чтобы само расписание не держало процесс живым.
 */
export function startRouteReportSchedule(run, {
  env = process.env,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onError = (error) => console.error('route report failed:', error?.message || error)
} = {}) {
  let timer = null;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    timer = setTimer(async () => {
      try {
        await run();
      } catch (error) {
        try { onError(error); } catch (_) { /* обработчик ошибки тоже не должен гасить расписание */ }
      }
      schedule();
    }, delayUntilNextTick(now()));
    if (typeof timer?.unref === 'function') timer.unref();
  };
  if (routeReportEnabled(env)) schedule();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
    }
  };
}
