export class EventBus {
  constructor() {
    this.handlers = new Map();
    this.events = [];
  }

  on(eventName, handler) {
    const handlers = this.handlers.get(eventName) ?? [];
    handlers.push(handler);
    this.handlers.set(eventName, handlers);
  }

  emit(eventName, payload = {}) {
    const event = { eventName, payload, at: new Date().toISOString() };
    this.events.push(event);
    for (const handler of this.handlers.get(eventName) ?? []) {
      handler(event);
    }
    return event;
  }

  history() {
    return [...this.events];
  }
}
