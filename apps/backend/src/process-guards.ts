// O código das integrações veio do Electron, onde promise rejeitada sem catch
// só gera log. No Node 22 ela derruba o processo — e a API inteira cai junto
// (ex.: `void unindexMemoryEntry(...)` falhando no disco). Aqui vira log.

export function installProcessGuards(
  proc: Pick<NodeJS.Process, 'on'>,
  log: { error(obj: Record<string, unknown>, msg: string): void },
): void {
  proc.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'unhandled rejection');
  });
}
