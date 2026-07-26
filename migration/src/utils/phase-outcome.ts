export interface PhaseOutcome {
  checkpoint: boolean;
}

export function allowsPartialDeals(
  args: readonly string[] = process.argv.slice(2),
): boolean {
  return args.includes("--allow-partial-deals");
}

export function shouldCheckpointPhase(
  outcome: PhaseOutcome | void,
): boolean {
  return outcome?.checkpoint !== false;
}
