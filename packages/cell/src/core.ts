import type { createHumanItems } from "./human-items";
import type { ChannelHub } from "@ng/protocol";
import type { GateService } from "@ng/gate";
import type { InboxService } from "@ng/inbox";
import type { AgentLoop, BoundsInit, Bus, CellRecord, CellsRepo, Clock, ContextStore, Db, Registry } from "@ng/protocol";
import type { WorkspaceManager } from "@ng/workspace";
import type { Dispatcher } from "./dispatcher";
import type { Escalations } from "./escalations";
import type { Lifecycle } from "./lifecycle";
import type { ReadModel } from "./readmodel";
import type { StallMonitor } from "./stall";
import type { Waits } from "./waits";
import type { Kernel } from "./types";

/** Everything the kernel's modules share. Built once by createKernel; modules are attached after construction. */
export interface KernelCore {
  cliRunners?: Kernel["cliRunners"];
  describeRunnerOptions: Kernel["describeRunnerOptions"];
  resolveRunnerSelection: Kernel["resolveRunnerSelection"];
  db: Db;
  bus: Bus;
  clock: Clock;
  registry: Registry;
  cells: CellsRepo;
  inbox: InboxService;
  context: ContextStore;
  gate: GateService;
  workspace: WorkspaceManager;
  hub: ChannelHub;
  loop: AgentLoop;

  dataDir: string;
  cliProcDir: string;
  ownerInstanceId: string;
  deskCellId: string;
  ownerPrincipal: string;
  rootBounds: BoundsInit;
  repoPath: string | undefined;
  leaseMs: number;
  maxConcurrentRuns: number;
  retryBackoffMs: number;
  maxRetryBackoffMs: number;
  maxStepContinuations: number;
  stallGraceMs: number;

  onError(err: unknown, where: string): void;
  /** Background work idle() must wait for (cleanup after a close, approval executions). */
  track<T>(p: Promise<T>): Promise<T>;
  pendingTasks(): number;
  /** Resolves when the currently tracked tasks have settled. */
  tasksSettled(): Promise<void>;
  lifecycle: Lifecycle;
  dispatcher: Dispatcher;
  escalations: Escalations;
  humanItems: ReturnType<typeof createHumanItems>;
  readModel: ReadModel;
  waits: Waits;
  stall: StallMonitor;
}

export function isProjectRoot(registry: Registry, cell: CellRecord | undefined): boolean {
  return !!cell?.preset && registry.presets.get(cell.preset)?.projectRoot === true;
}
