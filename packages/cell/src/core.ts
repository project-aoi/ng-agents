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

/** Everything the kernel's modules share. Built once by createKernel; modules are attached after construction. */
export interface KernelCore {
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
  deskCellId: string;
  ownerPrincipal: string;
  ownerAddresses: readonly string[];
  allowHostWrites: boolean;
  rootBounds: BoundsInit;
  repoPath: string | undefined;
  leaseMs: number;
  maxConcurrentRuns: number;
  retryBackoffMs: number;
  maxRetryBackoffMs: number;

  onError(err: unknown, where: string): void;
  /** Background work idle() must wait for (cleanup after a close, approval executions). */
  track<T>(p: Promise<T>): Promise<T>;
  pendingTasks(): number;
  /** Resolves when the currently tracked tasks have settled. */
  tasksSettled(): Promise<void>;
  /** Base repository for git_worktree/container when none is configured (created lazily). */
  ensureScratchRepo(): Promise<string>;

  lifecycle: Lifecycle;
  dispatcher: Dispatcher;
  escalations: Escalations;
  approvals: Approvals;
  readModel: ReadModel;
}
