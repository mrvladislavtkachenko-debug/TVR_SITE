import { describe, expect, it } from 'vitest';
import { jsonForScript } from '../src/index.js';

describe('jsonForScript (XSS-защита inline-скриптов, fix 12aa9d5)', () => {
  it('обычная строка → JSON-строка', () => {
    expect(jsonForScript('morning-checklist')).toBe('"morning-checklist"');
  });

  it('null/undefined → null', () => {
    expect(jsonForScript(null)).toBe('null');
    expect(jsonForScript(undefined)).toBe('null');
  });

  it('экранирует `<` — `</script>` не рвёт тег', () => {
    const out = jsonForScript('</script><img src=x onerror=alert(1)>');
    expect(out).not.toContain('</script>');
    expect(out).toBe('"\\u003c/script>\\u003cimg src=x onerror=alert(1)>"');
    // `>` остаётся как есть: без `<` он не открывает тег — безопасно
  });

  it('экранирует U+2028/U+2029 (ломают JS-парсер, валидны в JSON)', () => {
    const out = jsonForScript('a\u2028b\u2029c');
    expect(out).toBe('"a\\u2028b\\u2029c"');
    // результат парсится как JSON и равен исходной строке
    expect(JSON.parse(out)).toBe('a\u2028b\u2029c');
  });

  it('объекты сериализуются с теми же правилами', () => {
    const out = jsonForScript({ slug: '<x>', arr: ['</script>'] });
    expect(out).not.toContain('</script>');
    expect(out).not.toContain('<x>');
    expect(JSON.parse(out)).toEqual({ slug: '<x>', arr: ['</script>'] });
  });

  it('результат безопасен внутри <script>...</script>', () => {
    const evil = jsonForScript("';</script>try{alert(1)}catch(e){}//");
    const html = `<script>var x = ${evil};</script>`;
    expect(html).toContain('\\u003c/script>');
    // закрывающий тег встречается ровно один раз — наш собственный
    expect(html.match(/<\/script>/g)?.length).toBe(1);
  });
});
