import type { createHumanItems } from "./human-items";
import type { ChannelHubImpl } from "@ng/channel";
import type { GateService } from "@ng/gate";
import type { InboxService } from "@ng/inbox";
import type { AgentLoop, BoundsInit, Bus, CellsRepo, Clock, ContextStore, Db, Registry } from "@ng/protocol";
import type { WorkspaceManager } from "@ng/workspace";
import type { Approvals } from "./approvals";
import type { Dispatcher } from "./dispatcher";
import type { Escalations } from "./escalations";
import type { Lifecycle } from "./lifecycle";
import type { ReadModel } from "./readmodel";
import type { StallMonitor } from "./stall";
import type { Waits } from "./waits";

/** Everything the kernel's modules share. Built once by createKernel; modules are attached after construction. */
export interface KernelCore {
  defaultEngine: import("@ng/protocol").AgentEngine | null;
  db: Db;
  bus: Bus;
  clock: Clock;
  registry: Registry;
  cells: CellsRepo;
  inbox: InboxService;
  context: ContextStore;
  gate: GateService;
  workspace: WorkspaceManager;
  hub: ChannelHubImpl;
  loop: AgentLoop;

  dataDir: string;
  cliProcDir: string;
  deskCellId: string;
  ownerPrincipal: string;
  ownerAddresses: readonly string[];
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
  approvals: Approvals;
  humanItems: ReturnType<typeof createHumanItems>;
  readModel: ReadModel;
  waits: Waits;
  stall: StallMonitor;
}
