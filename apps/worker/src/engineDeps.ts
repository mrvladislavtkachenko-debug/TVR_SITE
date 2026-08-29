/**
 * Бочка зависимостей flow-движка: реальные db-сервисы. Тесты подменяют
 * отдельные функции через этот модуль (vitest alias/mocking не требуется —
 * движок принимает deps только для executor/templates/scheduler/log).
 */
export {
  addSegmentMembership,
  advanceFlowRun,
  countUserEvents,
  emitSafeBotEvent,
  enqueueOutbox,
  finishFlowRun,
  getActiveFlow,
  getChatIdForUser,
  getFlowDefinitionById,
  getFlowRun,
  getSegmentByCode,
  getUserFacts,
  getUserSegmentCodes,
  listActiveFlows,
  removeSegmentMembership,
  setProfileFieldWhitelisted,
  startFlowRun,
  writeAudit,
  cancelUserRunsOfFlow,
  type SqlExecutor,
  type TemplateStore,
} from '@tas/db/services';

/** Переменные рендера шаблона из контекста движка. */
export function getTemplateStoreVars(ctx: {
  facts: { first_name: string | null };
}): Record<string, string> {
  return { first_name: ctx.facts.first_name ?? '' };
}
