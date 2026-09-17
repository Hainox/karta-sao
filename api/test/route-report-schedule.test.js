// Планировщик отчёта по маршрутам: выравнивание по трёхчасовой границе, флаг
// включения по умолчанию, невозможность сдвоенного запуска, изоляция сбоя и
// отсутствие удержания процесса. Проверяется на подставных таймерах — без базы.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ROUTE_REPORT_INTERVAL_MS, delayUntilNextTick, routeReportEnabled, startRouteReportSchedule
} from '../lib/route-report-schedule.js';

const HOUR = 60 * 60 * 1000;
const NOON = Date.UTC(2026, 8, 16, 12, 0, 0);

// Подставные таймеры: запоминаем поставленные задачи и факт снятия с учёта.
function fakeTimers() {
  const pending = [];
  return {
    pending,
    setTimer(fn, delay) {
      const handle = { fn, delay, cleared: false, unreffed: false, unref() { this.unreffed = true; } };
      pending.push(handle);
      return handle;
    },
    clearTimer(handle) { handle.cleared = true; }
  };
}

test('выравнивает запуск по трёхчасовой границе', () => {
  assert.equal(ROUTE_REPORT_INTERVAL_MS, 3 * HOUR);
  // 12:34 → ближайшая граница 15:00, то есть 2 ч 26 мин.
  const now = Date.UTC(2026, 8, 16, 12, 34, 0);
  assert.equal(delayUntilNextTick(now), 2 * HOUR + 26 * 60 * 1000);

  // Момент срабатывания всегда кратен трём часам от эпохи (00:00, 03:00, 06:00…).
  for (const minutes of [0, 1, 59, 180, 181, 1234, 100000]) {
    const start = now + minutes * 60 * 1000;
    assert.equal((start + delayUntilNextTick(start)) % ROUTE_REPORT_INTERVAL_MS, 0, `сдвиг ${minutes} мин`);
  }

  // Точно на границе ждём целый интервал, а не ноль: иначе расписание сдвоилось бы.
  assert.equal(delayUntilNextTick(Date.UTC(2026, 8, 16, 3, 0, 0)), ROUTE_REPORT_INTERVAL_MS);
});

test('флаг включения по умолчанию выключен и признаёт только true', () => {
  assert.equal(routeReportEnabled({}), false);
  assert.equal(routeReportEnabled({ ODH_ROUTE_REPORT_ENABLED: '' }), false);
  assert.equal(routeReportEnabled({ ODH_ROUTE_REPORT_ENABLED: 'false' }), false);
  assert.equal(routeReportEnabled({ ODH_ROUTE_REPORT_ENABLED: '1' }), false);
  assert.equal(routeReportEnabled({ ODH_ROUTE_REPORT_ENABLED: 'yes' }), false);
  assert.equal(routeReportEnabled({ ODH_ROUTE_REPORT_ENABLED: 'true' }), true);
  assert.equal(routeReportEnabled({ ODH_ROUTE_REPORT_ENABLED: 'TRUE' }), true);
  // Без аргумента берётся process.env, где по умолчанию переменной нет.
  assert.equal(routeReportEnabled(), false);
});

test('при выключенном флаге расписание не поднимается', () => {
  const timers = fakeTimers();
  const control = startRouteReportSchedule(async () => {}, { env: {}, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  assert.equal(timers.pending.length, 0);
  control.stop();
});

test('ставит выровненный таймер, снимает его с учёта и не допускает сдвоенного запуска', async () => {
  const timers = fakeTimers();
  let runs = 0;
  let release;
  const run = () => { runs += 1; return new Promise((resolve) => { release = resolve; }); };
  const control = startRouteReportSchedule(run, {
    env: { ODH_ROUTE_REPORT_ENABLED: 'true' },
    now: () => NOON,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onError: () => {}
  });

  assert.equal(timers.pending.length, 1, 'поставлен один таймер');
  assert.equal(timers.pending[0].unreffed, true, 'расписание не держит процесс живым');
  assert.equal((NOON + timers.pending[0].delay) % ROUTE_REPORT_INTERVAL_MS, 0);

  // Пока отчёт не завершён, следующий таймер не ставится — сдвоенного запуска нет.
  const firing = timers.pending[0].fn();
  assert.equal(runs, 1);
  assert.equal(timers.pending.length, 1, 'новый таймер не поставлен до завершения отчёта');
  release();
  await firing;
  assert.equal(timers.pending.length, 2, 'следующий отчёт планируется после завершения текущего');
  assert.equal(timers.pending[1].unreffed, true);
  control.stop();
});

test('сбой отчёта гасится и не срывает следующую отправку', async () => {
  const timers = fakeTimers();
  const errors = [];
  const control = startRouteReportSchedule(async () => { throw new Error('нет связи'); }, {
    env: { ODH_ROUTE_REPORT_ENABLED: 'true' },
    now: () => 0,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onError: (error) => errors.push(error.message)
  });

  await timers.pending[0].fn();
  assert.deepEqual(errors, ['нет связи']);
  assert.equal(timers.pending.length, 2, 'после сбоя расписание продолжается');
  control.stop();
});

test('сбой самого обработчика ошибки тоже не гасит расписание', async () => {
  const timers = fakeTimers();
  const control = startRouteReportSchedule(async () => { throw new Error('x'); }, {
    env: { ODH_ROUTE_REPORT_ENABLED: 'true' },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onError: () => { throw new Error('onError'); }
  });

  await timers.pending[0].fn();
  assert.equal(timers.pending.length, 2);
  control.stop();
});

test('остановка снимает таймер и больше не планирует', () => {
  const timers = fakeTimers();
  const control = startRouteReportSchedule(async () => {}, {
    env: { ODH_ROUTE_REPORT_ENABLED: 'true' },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });
  const first = timers.pending[0];
  control.stop();
  assert.equal(first.cleared, true);
});
