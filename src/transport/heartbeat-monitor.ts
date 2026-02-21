export class HeartbeatMonitor {
  private timer?: NodeJS.Timeout;
  private lastHeartbeat = Date.now();

  constructor(
    private readonly timeoutMs: number,
    private readonly onDisconnect: (reason: string) => void,
  ) {}

  heartbeat(): void {
    this.lastHeartbeat = Date.now();
  }

  start(): void {
    this.stop();
    this.timer = setInterval(
      () => {
        if (Date.now() - this.lastHeartbeat > this.timeoutMs) {
          this.onDisconnect("Control channel heartbeat timeout");
        }
      },
      Math.min(this.timeoutMs, 1_000),
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
