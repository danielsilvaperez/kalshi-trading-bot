export class CircuitBreaker {
  private failures = 0;
  private open = false;

  constructor(private threshold: number) {}

  canRun(): boolean {
    return !this.open;
  }

  onSuccess(): void {
    this.failures = 0;
    this.open = false;
  }

  onFailure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) this.open = true;
  }

  status() {
    return { failures: this.failures, open: this.open, threshold: this.threshold };
  }
}
