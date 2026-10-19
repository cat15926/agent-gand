/** Abort is a prompt notification. Durable epochs remain the authorization boundary. */
const active = new Map<string, Set<AbortController>>();

export function watchThreadedExecution(invocationId: string, controller: AbortController): () => void {
  const controllers = active.get(invocationId) ?? new Set<AbortController>();
  controllers.add(controller);
  active.set(invocationId, controllers);
  return () => {
    controllers.delete(controller);
    if (controllers.size === 0) active.delete(invocationId);
  };
}

export function abortThreadedExecution(invocationId: string): void {
  for (const controller of active.get(invocationId) ?? []) controller.abort();
}
