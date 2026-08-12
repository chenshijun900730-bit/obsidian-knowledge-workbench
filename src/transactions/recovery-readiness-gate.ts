export class RecoveryReadinessGate {
  private ready = false;
  private generation = 0;

  static readyForTests(): RecoveryReadinessGate {
    const gate = new RecoveryReadinessGate();
    gate.open(gate.lease());
    return gate;
  }

  isReady(): boolean {
    return this.ready;
  }

  organizationWritesBlocked(): boolean {
    return !this.ready;
  }

  lease(): number {
    return this.generation;
  }

  open(lease: number): boolean {
    if (lease !== this.generation) return false;
    this.ready = true;
    return true;
  }

  reset(): void {
    this.generation += 1;
    this.ready = false;
  }
}
