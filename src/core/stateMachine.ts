export type VibeState =
  | "IDLE"
  | "COLLECTING_CONTEXT"
  | "GENERATING_LLM"
  | "VALIDATING_PIPELINE"
  | "AUTO_FIX_LOOP"
  | "APPLIED"
  | "FAILED";

export class VibeStateMachine {
  private state: VibeState = "IDLE";

  public transitionTo(nextState: VibeState): void {
    console.log(`[StateMachine] ${this.state} -> ${nextState}`);
    this.state = nextState;
  }

  public getState(): VibeState {
    return this.state;
  }
}
