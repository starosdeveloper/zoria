/* bot :: main
   провід бота: присяга, повтор першого входу, повернення після обриву,
   перевірка пінів. Стан голови - у seat.ts, стратегія - у strategy.ts;
   мережі й оточення тут рівно стільки, щоб решта про них не знала.

   Оточення виставляє вузол локального пакета (npm run play) або стек
   (zaria-kit init stack):
     ZARIA_URL     адреса вузла
     ZARIA_TOKEN   печатка місця
     ZARIA_ENGINE  хеш рушія, якого бот вимагає від вузла; порожньо - хеш
                   встановленого @zoria/engine. Чужий хеш - бот рве
                   провід сам: грати не в той світ гірше, ніж не грати
     ZARIA_BELIEF  файл щоденника віри (NDJSON); порожньо - не писати
     ZARIA_PRESET  голова слота: жатва (типово) або архетип дзеркала для спарингу
     ZARIA_FREEZE  1 - здачу заморожено: зміна пресета відповідає відмовою
     ZARIA_AGENT   ім'я агента в присязі (zaria-bot)
     STATUS_PORT   внутрішній службовий порт (status.ts); порожньо - без нього
     STATUS_HOST   інтерфейс службового порту (0.0.0.0)

   Одна партія - одна присяга: пам'ять між партіями не переноситься
   (правила 25.4). Без службового порту процес виходить одразу після
   прощання вузла - так на нього і чекає локальний пакет. Зі службовим
   портом голова лишається жива і відповідає про кінець партії, доки стек
   не згасять: на цій відповіді стоїть /health службового контракту. */

import { ENGINE_HASH } from '@zoria/engine';
import { connectBot } from '@zoria/sdk';
import { withJitter } from './jitter.js';
import { Seat } from './seat.js';
import { statusServer } from './status.js';
import { HARVEST } from './strategy.js';

const log = (line: string): void => {
  process.stdout.write(line + '\n');
};
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const env = process.env;
const url = env['ZARIA_URL'] ?? '';
const token = env['ZARIA_TOKEN'] ?? '';
const engine = env['ZARIA_ENGINE'] || ENGINE_HASH;
const statusPort = Number(env['STATUS_PORT'] ?? '') || 0;

/* наш пресет по умолчанию: имя архетипа здесь означало бы, что в зачёт уедет
   заглушка шаблона, а лог при этом выглядел бы как обычная партия */
const seat = new Seat({
  preset: env['ZARIA_PRESET'] || HARVEST,
  freeze: env['ZARIA_FREEZE'] === '1',
  engine,
  beliefFile: env['ZARIA_BELIEF'] ?? '',
});

const server = statusPort ? statusServer(seat.head) : null;
if (server) server.listen(statusPort, env['STATUS_HOST'] || '0.0.0.0', () => log('службовий порт ' + statusPort));

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    if (seat.run) seat.run.close();
    if (server) server.close();
    setTimeout(() => process.exit(0), 500).unref();
  });
}

if (!url || !token) {
  /* адреси немає: у локальному пакеті це помилка запуску, а в стеку -
     простій. Службовий порт відповідає про простій чесним 503 */
  seat.why = 'потрібні ZARIA_URL і ZARIA_TOKEN: бота запускає вузол (npm run play) або стек';
  log(seat.why);
  if (!server) process.exit(2);
} else {
  /* перший вхід повторюється з повним джитером: вузол міг ще не відкрити
     лобі. Повернення в бою веде connectBot сам */
  try {
    seat.run = await withJitter(
      { tries: 20, ceilMs: 2000, onRetry: (n, ms, e) => log('вхід ' + n + ' не вдався (' + errText(e) + '), повтор через ' + ms + ' мс') },
      () =>
        connectBot({
          url,
          token,
          agent: env['ZARIA_AGENT'] || 'zaria-bot',
          bot: seat.bot,
          engine,
          onTick: (t, n) => seat.onTick(t, n),
        }),
    );
  } catch (e) {
    /* піни розійшлися, печатка не та, вузол не відкрив лобі: у партію не входимо */
    seat.phase = 'done';
    seat.why = 'у партію не ввійшов: ' + errText(e);
    log(seat.why);
    if (!server) process.exit(1);
  }

  const run = seat.run;
  if (run) {
    seat.phase = 'live';
    log('місце ' + run.slot + ', тактів ' + run.ack.ticks + ', рушій ' + run.ack.engine.slice(0, 12));
    seat.why = await run.done;
    seat.phase = 'done';
    log(seat.summary());
    /* окремим рядком - лічильники самої голови: провід рахує кадри, а лестниця
       К3 оцінювання питає про команди (8.5) */
    const own = seat.strategy.report();
    if (own) log(own);
    if (!server) process.exit(0);
  }
}
