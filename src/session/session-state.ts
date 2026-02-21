import type { SessionStatus } from "../lib/domain-schemas.js";

const TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  starting: ["ready", "failed"],
  ready: ["disconnected", "terminated"],
  disconnected: ["starting", "terminated"],
  failed: ["starting", "terminated"],
  terminated: [],
};

export class SessionStateMachine {
  constructor(private status: SessionStatus = "starting") {}

  getStatus(): SessionStatus {
    return this.status;
  }

  transition(next: SessionStatus): SessionStatus {
    const allowed = TRANSITIONS[this.status];
    if (!allowed.includes(next)) {
      throw new Error(`Invalid transition ${this.status} -> ${next}`);
    }
    this.status = next;
    return this.status;
  }
}
