/**
 * JSON для встраивания в inline-<script> (fix reflected XSS, 12aa9d5).
 * JSON.stringify НЕ экранирует `<`, поэтому `</script>` внутри значения
 * рвёт тег скрипта. Экранируем `<`, U+2028/U+2029 (line separators —
 * валидны в JSON-строках, но ломают JS-парсер).
 *
 * ЕДИНСТВЕННЫЙ способ встраивания JSON в inline-скрипты в TAS.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
