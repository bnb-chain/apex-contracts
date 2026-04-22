/**
 * Flow registry. Each flow is an async `(ctx) => FlowResult` function; the
 * runner executes them in listed order and aggregates results.
 */

import type { E2EContext } from "../context.js";

import { runHappy } from "./happy.js";
import { runDisputeReject } from "./dispute-reject.js";
import { runStalemateExpire } from "./stalemate-expire.js";
import { runOpenCancel } from "./open-cancel.js";
import { runNeverSubmit } from "./never-submit.js";

export interface FlowResult {
  name: string;
  passed: boolean;
  jobId?: bigint;
  error?: unknown;
}

export type Flow = (ctx: E2EContext) => Promise<FlowResult>;

export const FLOWS: { name: string; run: Flow }[] = [
  { name: "A · happy (silence → approve)", run: runHappy },
  { name: "B · dispute → reject", run: runDisputeReject },
  { name: "C · stalemate → expire", run: runStalemateExpire },
  { name: "D · open cancel", run: runOpenCancel },
  { name: "E · never submit → expire", run: runNeverSubmit },
];
