// @ng/loop/testing — in-memory RunPorts and PromptSnapshot for testing Loops, toolsets and code processors.
export {
  createFakeRun,
  defaultFakeBounds,
  fakeInspection,
  renderEnvelope,
  userMessage,
  type FakeLog,
  type FakeRun,
  type FakeRunOptions,
  type FakeRunPorts,
} from "./fake-ports";
export * from "../models/scripted";
export { installFakeCli, FAKE_CLI_PATH, type FakeCli, type FakeCliAction, type FakeCliTurn, type FakeCliLogEntry } from "./fake-cli";
