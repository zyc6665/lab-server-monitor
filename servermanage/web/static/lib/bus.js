export function createBus() {
  const listeners = new Map();

  return {
    on(eventName, handler) {
      const handlers = listeners.get(eventName) || new Set();
      handlers.add(handler);
      listeners.set(eventName, handlers);
      return () => {
        handlers.delete(handler);
        if (!handlers.size) { listeners.delete(eventName); }
      };
    },
    emit(eventName, payload) {
      const handlers = listeners.get(eventName);
      if (!handlers) { return; }
      Array.from(handlers).forEach((handler) => handler(payload));
    },
  };
}
