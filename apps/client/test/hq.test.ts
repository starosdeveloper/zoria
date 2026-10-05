/* Вкладка штаба рисуется без файла: поле загрузки и якоря на месте. Без
   браузера — серверным рендером; это проверка разметки, а не поведения. */

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HqView } from '../src/views/HqView.tsx';
import { VIEWS } from '../src/state/model.ts';

describe('HqView', () => {
  it('без дневника — только поле загрузки, якоря размечены', () => {
    const html = renderToString(createElement(HqView));
    expect(html).toContain('data-hq="belief"');
    expect(html).toContain('data-hq-input="belief"');
    expect(html).not.toContain('data-hq-scrub');
  });

  it('вкладка штаба есть в списке вкладок клиента', () => {
    expect(VIEWS).toContain('hq');
  });
});
