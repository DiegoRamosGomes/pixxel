// Quanto tempo cada tipo de widget fica na tela.

export function ttlForWidget(kind: string): number {
  switch (kind) {
    case 'weather':
      return 30_000;
    case 'tasks-list':
      return 60_000;
    case 'task-detail':
      return 90_000;
    case 'youtube':
      return 45_000;
    case 'search-results':
      return 90_000;
    default:
      return 30_000;
  }
}
