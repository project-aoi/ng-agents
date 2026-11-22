// @ng/loop/testing — in-memory RunPorts and PromptSnapshot for testing Loops, toolsets and code processors.
export {
  createFakeRun,
  fakeInspection,
  type FakeRun,
  type FakeRunOptions,
  type FakeRunPorts,
} from "./fake-ports";
export { createScriptedLoop, TRUNCATED_CALL_OUTPUT } from "./scripted-loop";
export type { ModelRequest } from "./model";
export { ScriptedModelClient, call, say, type ScriptResponder, type ScriptTurn } from "../models/scripted";
export { installFakeCli, type FakeCli, type FakeCliTurn } from "./fake-cli";
