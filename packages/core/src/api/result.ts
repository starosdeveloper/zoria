// Every call ends in exactly one of these outcomes. The UI switches on `kind`
// and never has to guess from a thrown exception (CL-01, CL-36).

export type Failure =
  /** Server answered with a stable error code (4xx other than 429). */
  | { kind: 'api'; status: number; code: string; field: string | null; requestId: string | null }
  /** 429: wait `retryAfterSec` before this request goes again (CL-07). */
  | { kind: 'throttled'; code: string; retryAfterSec: number; requestId: string | null }
  /** Body is a sealed ether envelope (503 before the window) — hand it to the ether monitor, not a failure. */
  | { kind: 'ether'; status: number; body: string; requestId: string | null }
  /** 5xx without an envelope: retry with backoff (CL-09); show requestId (CL-37). */
  | { kind: 'server'; status: number; code: string | null; requestId: string | null; retryAfterSec: number | null }
  /** Status/body that fits no contract shape: before the window this is noise. */
  | { kind: 'foreign'; status: number; requestId: string | null }
  /** Transport failure: timeout, reset, DNS, offline. */
  | { kind: 'network'; reason: 'timeout' | 'failed' | 'aborted'; message: string }
  /** Request was never sent: the local jam guard holds the line until `until` (epoch ms). */
  | { kind: 'silenced'; until: number };

export type Result<T> = { ok: true; status: number; data: T; requestId: string | null } | { ok: false; error: Failure };

/** Failures that mean "the answer may have been lost" — the request might or might not have reached the server. */
export function isLostResponse(f: Failure): boolean {
  return (f.kind === 'network' && f.reason !== 'aborted') || f.kind === 'server' || f.kind === 'foreign';
}

/** Failures the caller should retry with exponential backoff (CL-09). */
export function isTransient(f: Failure): boolean {
  return (f.kind === 'network' && f.reason !== 'aborted') || f.kind === 'server';
}

const ERROR_TEXT: Record<string, string> = {
  'invalid-json': 'Запрос не является JSON-объектом.',
  'invalid-fields': 'Лишнее или пропущенное поле в запросе.',
  'invalid-query': 'Неверные параметры страницы.',
  'authentication-required': 'Нужно войти.',
  'invalid-credentials': 'Неверный логин или пароль.',
  'registration-closed': 'Регистрация закрыта: просвет закончился.',
  'session-required': 'Действие доступно только с сессией входа по логину и паролю.',
  'origin-not-allowed': 'Запрос с cookie с чужого origin отклонён.',
  'not-found': 'Нет такого ресурса или он ещё не выдан.',
  'username-unavailable': 'Логин занят.',
  'repository-already-verified': 'Репозиторий уже подтверждён за другим аккаунтом. Проверьте .zoria и пишите организаторам.',
  'registration-capacity': 'Достигнут лимит аккаунтов сервера. Пишите организаторам.',
  'session-limit': 'Слишком много активных сессий. Выйдите из лишних.',
  'body-too-large': 'Тело запроса больше 96 КиБ.',
  'json-required': 'Нет заголовка Content-Type: application/json.',
  'invalid-field': 'Поле не прошло проверку.',
  'invalid-invitation': 'Код заявки чужой, уже использован или просрочен. Проверьте код из письма; за новым — к организаторам.',
  'invalid-repository': 'Это не адрес репозитория GitHub.',
  'repository-not-root': 'Нужна ссылка на сам репозиторий, а не на файл, ветку или вкладку.',
  'repository-not-eligible': 'Сервер не принял этот репозиторий. Нужен ваш собственный частный репозиторий на GitHub.',
  jammed: 'Адрес заглушён за превышение лимита эфира.',
  'rate-limited': 'Превышен лимит запросов.',
  'authentication-busy': 'Очередь проверки паролей занята, повтор через несколько секунд.',
  'internal-error': 'Ошибка сервера.',
  stopping: 'Узел молчит или перезапускается — повтор с паузой.',
};

/** Server sends codes only; texts are ours. Unknown code falls back to its HTTP status class (spec §5.5). */
export function describeFailure(f: Failure): string {
  switch (f.kind) {
    case 'api':
      return ERROR_TEXT[f.code] ?? describeStatus(f.status);
    case 'throttled':
      return `${ERROR_TEXT[f.code] ?? 'Сервер просит подождать.'} Ждём ${f.retryAfterSec} с.`;
    case 'ether':
      return 'Сервер в режиме эфира: обычного API ещё нет.';
    case 'server':
      return `${(f.code && ERROR_TEXT[f.code]) ?? 'Сбой сервера.'}${f.requestId ? ` X-Request-Id: ${f.requestId}` : ''}`;
    case 'foreign':
      return 'Ответ не по контракту (до просвета — помеха).';
    case 'network':
      if (f.reason === 'aborted') return 'Запрос отменён.';
      return f.reason === 'timeout' ? 'Сервер не ответил вовремя.' : `Нет связи: ${f.message}`;
    case 'silenced':
      return `Молчим до ${new Date(f.until).toLocaleTimeString()}: адрес заглушён.`;
  }
}

function describeStatus(status: number): string {
  if (status === 400) return 'Ошибка запроса клиента.';
  if (status === 401) return 'Нужно войти.';
  if (status === 403) return 'Нет прав или действие закрыто.';
  if (status === 404) return 'Не найдено или ещё не выдано.';
  if (status === 409 || status === 422) return 'Конфликт или неверное поле.';
  return `Ответ ${status}.`;
}
