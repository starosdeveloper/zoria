# SDK Зорі: `@zoria/sdk`

SDK - заготовка бота, клієнт проводу, довідник правил, суперники для
спарингу і локальна партія в процесі. Усі пакети конкурсу ставляться з
приватного реєстру `https://npm.zoria.net/` (налаштування - `02-path.md`, кроки 1-2)
і виходять під ліцензією MIT.

## 1. Пакети

| Пакет | Що в ньому | Кому потрібен |
|---|---|---|
| `@zoria/engine` | рушій світу: `createEngine()`, `ENGINE_HASH` | дзеркалу, оракулу, реплею, локальній партії |
| `@zoria/protocol` | схема `protocol.cddl`, кодек, типи кадрів, тарифи | будь-якому боту |
| `@zoria/sdk` | заготовка бота, `connectBot`, оракул, суперники, харнес, щоденник віри, реплей | будь-якому боту |
| `@zoria/nakaz` | формат грамоти, словник, лінтер ступенів 1-2, інтерпретатор | наказу |
| `@zoria/server`, `@zoria/tournament` | вузол і турнір: на них працює локальний пакет | через `@zoria/kit` |
| `@zoria/kit` | шаблон бота і команда `zaria-kit`: `init`, `pack`, `lint`, `replay`, `version` | усім (`02-path.md`, `06-local-pack.md`) |

Версії пакетів виходять разом: в одного випуску один `ENGINE_HASH`. Зсув
світу - новий випуск, `npm update` (`02-path.md`, крок 8).

Типи кадрів (`Observe`, `Order`, `Manifest`, `SlotName`) і кодек
(`decodeObserve`, `encodeOrders`, ...) беруться з `@zoria/protocol`; SDK
реекспортує тільки контракт `WireBot`.

Вимоги: бот на TypeScript або JavaScript (`01-rules.md`, 3.1), Node.js 24
або новіший (клієнт проводу бере глобальний `WebSocket`), ESM
(`"type": "module"`).

## 2. Бот на проводі: `WireBot` і `BlankBot`

Контракт бота - три методи над байтами протоколу:

```ts
interface WireBot {
  init(manifestBytes: Uint8Array, slot: SlotName): void;   // маніфест, один раз
  tick(observeBytes: Uint8Array): Uint8Array;               // кадр такту -> кадр команд
  feedback?(verdictBytes: Uint8Array): void;                // вердикти, тим самим тактом
}
```

Бот не бачить рушія вузла: тільки кадри. Тому бот, який грає у вас,
грає так само на заліковому вузлі.

`BlankBot` - заготовка: розбирає маніфест (`this.manifest`), запам'ятовує слот
(`this.slot`) і останній кадр (`this.last`) і викликає `think()`. Перевизначте
`think()`:

```ts
import { BlankBot } from '@zoria/sdk';
import type { Observe, Order } from '@zoria/protocol';

export class MyBot extends BlankBot {
  private ordered = false;
  protected override think(obs: Observe): Order[] {
    // корпус у черзі верфі в кадрі не видно: замовляти один раз
    if (!this.ordered && obs.mine.units.length === 0) {
      this.ordered = true;
      return [{ kind: 'yard', cls: 'ткач' }];
    }
    return [];
  }
}
```

- Кадр, який не розібрався, `BlankBot` перетворює на порожній список команд.
- Порожній список команд - мовчання такту; шість мовчань поспіль віддають слот
  наказу (`01-rules.md`, розділ 23). Незмінений `BlankBot` у заліку грає
  грамотою.
- У `BlankBot` немає `feedback`; свій пишеться без `override`.
- Команди - об'єкти `Order` з `@zoria/protocol`: `{ kind: 'move', unit, q, r,
  goal, home }` і так далі, дванадцять родів (`04-protocol.md`, 6.1). Класи
  машин у типах - `'ткач'` і `'клинок'`.

## 3. Клієнт проводу: `connectBot`

```ts
import { connectBot } from '@zoria/sdk';
import { ENGINE_HASH } from '@zoria/engine';

const run = await connectBot({
  url: process.env['ZARIA_URL']!,
  token: process.env['ZARIA_TOKEN']!,
  agent: 'my-bot',
  bot: new MyBot(),
  engine: ENGINE_HASH,          // вимагати той самий рушій у вузла
});
console.log('слот', run.slot, 'тактів', run.ack.ticks);
const why = await run.done;     // 'end' | 'close:<код>' | 'timeout:<мс>'
```

Параметри `ConnectOpts`:

| Поле | Типово | Зміст |
|---|---|---|
| `url`, `token`, `bot` | - | адреса вузла, печатка місця, ваш `WireBot` |
| `agent` | `'bot'` | ім'я агента в присязі |
| `engine`, `ruleset` | не перевіряти | піни, які клієнт вимагає від вузла |
| `onTick(t, frames)` | - | після відправлення відповіді такту |
| `onVerdicts(v)` | - | вердикти такту |
| `connectTimeoutMs` | 5000 | скільки чекати `hello.ack` від нового сокета; 0 - не чекати |
| `resumeTries` | 3 | спроб повернення на один обрив |
| `resumeJitterMs` | 150 | стеля паузи повторного повернення, поки йде партія |
| `resumeLobbyJitterMs` | 2000 | та сама стеля в лобі |

Що `connectBot` робить сам:

- проміс завершується після першого маніфесту й успішного `bot.init`; кидок
  з `init` - несумісність, з'єднання закривається кодом 4001;
- перевіряє піни `hello.ack` і маніфесту; під час повернення піни, слот і
  довжина партії мусять збігтися з першими;
- відкидає кадри з номером, не новішим за останній отриманий
  (дедуплікація, `04-protocol.md`, розділ 9);
- повертається після обриву і за повідомленням `rotate`: перша спроба одразу,
  наступні - з паузою, рівномірною від нуля до зростаючої стелі;
- кидок з `tick` або `feedback` вважає мовчанням такту (`stats.faults`), а не
  кінцем процесу;
- відповідь, яка не пішла через обрив, надсилає новим сокетом
  (`stats.deferred`).

Перше підключення `connectBot` не повторює: вузол міг ще не відкрити лобі.
Повтор першого входу з тією самою паузою - у `src/main.ts` шаблону.

`run.stats` (`WireStats`): `ticks`, `orders`, `nacks`, `bytesIn`, `bytesOut`,
`resyncMs`, `lastTickAt`, `resumes`, `faults`, `deferred`. `run.close()`
закриває сокет кодом 4000.

## 4. Правила без бою: `RulesOracle`

Оракул - той самий рушій, що й у вузла, запущений від маніфесту, який ніколи
не проходить жодного такту. Він відповідає на "чи можна" і "почім" за
статикою долини:

```ts
import { createEngine } from '@zoria/engine';
import { RulesOracle } from '@zoria/sdk';

const o = new RulesOracle(createEngine, manifestBytes);
o.path(from, to, 'ткач');        // той самий пошук шляху, що будує вузол; null - шляху немає
o.stepCost(from, to, 'клинок');  // тактів на крок
o.canStep(from, to);             // прохідність і урвище
o.canSee(from, to);              // ярус
o.linkOk(a, b);                  // чи дотягується нитка
o.storm(at, t);                  // чи діє шторм (пляма мінус тиха заводь)
o.orderCost('move', at, t);      // ціна команди, яку спише воротар
o.eyeCost(2, at, t);             // ціна ока за такт
o.dawn();                        // { at, ring }
```

- Оракул вимагає той самий рушій, що записаний у маніфесті: інакше
  конструктор кидає `ReplayCompatibilityError` з кодом `ENGINE_MISMATCH`.
- Оракул не знає нічого, що живе тактом: чужих голок, завад, машин. Це дає
  кадр спостереження.
- `path` не знає зайнятості сот машинами (вузол теж, `01-rules.md`, 10.4).
- `orderCost('scan', ...)` не знає жетона патрона: спалах за жетоном
  безплатний (`01-rules.md`, 16.4).
- `oracle.engine` відкритий для читання довідкових таблиць рушія
  (`TERRAIN_TYPES`, `NEEDLES`, `FIND_CFG`); проганяти ним такти не можна.

## 5. Тарифи протоколу

`@zoria/protocol` рахує тарифи за числами `cfg` маніфесту без рушія:

| Функція | Що рахує |
|---|---|
| `budgetUp(cfg, lit)` | канал такту при `lit` голках, що горять |
| `budgetDown(cfg, lit)` | підлога вух плюс внесок мережі; без запасу нерухомих очей (`01-rules.md`, 13.2) - фактичний бюджет буває більшим |
| `orderCap(cfg, chanAt)` | стеля команд у кадрі |
| `orderCost(cfg, kind, at?, t?, storms?)` | ціна команди; без соти й такту - поза штормом |
| `eyeCost(cfg, rad, at?, t?, storms?)` | ціна ока |
| `stormAt(storms, q, r, t)` | чи під плямою сота |

Тарифи протоколу тихої заводі не знають: її радіус живе в рушії, а не в
маніфесті. Усередині заводі під плямою `stormAt`, `orderCost` і `eyeCost` з
плямами завищують ціну вдвічі. Точна ціна - у `RulesOracle`.

`manifest.cfg` типізовано як `Record<string, number>`; для тарифів його
приводять до типу: `manifest.cfg as unknown as ChannelCfg`.

## 6. Суперники і дзеркало: `ARCHETYPES`, `sampleBot`, `MirrorBot`

`MirrorBot` - вбудована голова рушія на проводі: у неї свій екземпляр
рушія, який живе тільки кадрами протоколу. Це сильний суперник для
спарингу і готова віра про світ.

```ts
import { createEngine } from '@zoria/engine';
import { ARCHETYPES, MirrorBot, sampleBot } from '@zoria/sdk';

const a = sampleBot(createEngine, 'облягач');                          // за ім'ям
const b = new MirrorBot(createEngine, { ...ARCHETYPES['рівний'], pact: 0 }); // свій варіант
```

- Архетипи: `рівний`, `шир`, `обхідник`, `проривник`, `облягач`. Об'єкти не
  заморожені: варіант робіть копією.
- `MirrorBot` вимагає той самий рушій, що й у вузла, і ті самі ключі `cfg`.
- `mirror()` віддає дзеркальний світ - віру бота; з нього пишеться щоденник
  віри (розділ 8).
- `stats.stale` - відкинуті дублі кадрів, `stats.drift` - пропущені такти,
  які дзеркало наздогнало без рішень.
- Здобич завади (`01-rules.md`, 8.7) дзеркало в оцінку соти не бере: чи жива
  вона, залежить від чужої мережі, а такого знання у голови немає. Вбудовані
  голови міряють соту своєю тягою і на здобич не розраховують - свою голову
  будуйте так само, інакше вона рахуватиме хвилини, яких не побачить.

## 7. Партія і пакет у процесі: `runMatch`, `runPack`

Харнес грає партію в одному процесі: без мережі, без дедлайнів, без стража
наказу. Це швидкі досліди; дедлайн, повернення і наказ перевіряє локальний
пакет через вузол (`06-local-pack.md`).

```ts
import { createEngine } from '@zoria/engine';
import { ARCHETYPES, runPack, sampleBot } from '@zoria/sdk';

const pack = runPack(createEngine, {
  seed: 2026,
  ticks: 1200,
  cast: [
    { bot: () => new MyBot() },                         // ваш бот, новий на кожну партію
    { bot: () => sampleBot(createEngine, 'облягач') },  // дзеркало архетипу на проводі
    { style: ARCHETYPES['рівний'] },                    // вбудована голова рушія
  ],
});
console.log('частки:', pack.shares);                     // [ваш, другий, третій], до 9
for (const m of pack.matches) console.log(m.score, m.breakdown, m.garbage, m.oversize);
```

- `runPack` садить ролі по колу: партія 1 - A, B, C; партія 2 - B, C, A;
  партія 3 - C, A, B. Місця і частки - за правилами `01-rules.md`, 24.3-24.5.
- `runMatch(factory, { seed, ticks, bots, styles })` - одна партія; слот без
  бота веде вбудована голова.
- `MatchResult`: `score`, `breakdown` (мережа, замовлення, податок, здобич),
  `minutes`, `needles`, `lit`, `energy`, `garbage` (кадрів, які не
  розібралися), `oversize` (кадрів, товщих за стелю).
- `openMatch(factory, opts)` - та сама партія за кроками (`step()`, `t()`,
  `done()`, `summary()`) для налагодження.

## 8. Щоденник віри: `BeliefTrace`

Щоденник віри - що бот вважає правдою про світ такт за тактом, рядок NDJSON
на такт. Шаблон пише його в запис локального пакета.

```ts
import { BeliefTrace, beliefLine } from '@zoria/sdk';

const trace = new BeliefTrace(slot);                 // повний кадр кожні 200 викликів
const frame = trace.frame(mirrorBot.mirror()!, obs); // BeliefFrame
appendFileSync(path, beliefLine(frame));
```

`BeliefFrame`: `t`, `pulse` (заряд, канал, вуха, хвилини, голки), `own`
(власник за сотою `"q,r"`), `dark`, `foe` (`[ім'я, власник, q, r]` цього
такту), `noisy`, `units` (`[ім'я, q, r, довжина шляху]`), `pact`, `cries`. Кадри
між повними несуть тільки зміни `own` і `dark`. `BeliefTrace` читає віру
дзеркального світу; бот без дзеркала збирає `BeliefFrame` сам.

## 9. Наказ із коду: `@zoria/sdk/nakaz`

```ts
import { readFileSync } from 'node:fs';
import { createEngine } from '@zoria/engine';
import { lintNakaz, reportIssues } from '@zoria/nakaz';
import { lintNakazRun, createNakazSparring, NAKAZ_SAMPLES } from '@zoria/sdk/nakaz';

const bytes = readFileSync('nakaz.yaml');
const { nakaz, issues } = lintNakaz(bytes);               // ступені 1-2
console.log(reportIssues(issues));                        // рядки з кодами, як у zaria-kit lint
const report = lintNakazRun(createEngine, bytes);          // ступінь 3: повний бій
const rival = createNakazSparring(NAKAZ_SAMPLES['черепаха']); // суперник-грамота
```

`lintNakaz` повертає `{ nakaz, issues }`: `nakaz` - розібрана грамота або
`null`, якщо є помилки; `issues` - зауваги (`Issue`: `level`, `code`,
`rule`, `line`, `text`).

- `lintNakazRun(factory, nakaz, { seed, ticks, slot, lang })` - грамота грає
  партію проти двох порожніх місць; `report.ok`, `report.why`, `report.issues`
  (попередження `refused` при частці відмов понад 30 %). `lang` - мова
  текстів, `'uk'` (за замовчуванням) або `'en'`; так само `lintNakaz(bytes,
  { lang })` і `reportIssues(issues, lang)` пакета `@zoria/nakaz`.
- `createNakazSparring(bytes, { lang })` - `WireBot` із грамоти; зламана
  грамота кидає одразу, текст помилки - мовою `lang`. Годиться в `runPack` і
  в локальний пакет.
- `NAKAZ_SAMPLES` - тексти шести зразків за іменами: `черепаха`, `експансія`,
  `економка`, `хвилини`, `замовлення`, `тиск`.
- `CountedBot` - обгортка `WireBot`, яка рахує подані, прийняті й
  відхилені команди; зручна у власних тестах.

Підшлях працює тільки в Node.js: зразки читаються з файлів пакета.

## 10. Записи партій: `openJournal`

Журнал партії (`.runlog`) відтворюється рушієм без ботів:

```ts
import { readFileSync } from 'node:fs';
import { createEngine } from '@zoria/engine';
import { openJournal } from '@zoria/sdk';

const c = openJournal(createEngine, readFileSync('records/pack-.../match-1.runlog'));
c.seek(600);                     // світ на 600-му такті
console.log(c.engine.SIM.world.minutes);
c.seek(c.ticks);
console.log(c.summary().score);
```

- `seek(t)` іде вперед і назад: назад - від найближчої контрольної точки
  (кожні 50 тактів).
- Слот, чиї кадри в журнал не записано, веде вбудована голова.
- Журнал іншого рушія або інших чисел світу відкидається
  `ReplayCompatibilityError` з кодом `ENGINE_MISMATCH` або `CONFIG_MISMATCH`;
  журнал іншої версії проводу - помилкою розбору з названою версією.
- Команда `zaria-kit replay` робить те саме для запису пакета з консолі
  (`06-local-pack.md`).

## 11. Що не для учасників

Інші експорти SDK - нутрощі вузла і переглядача: роздільний такт
(`SplitBot`), страж наказу (`NakazGuard`), спостерігач за ефіром
(`RelayFollower`), подання команди воротарю (`submitVerdict`, `submitWire`),
типи нутрощів рушія (`DemoOrder`, `BelState`). На них не спирайтеся: вони
змінюються без оголошення. Публічні розділи 2-10 цього документа.
