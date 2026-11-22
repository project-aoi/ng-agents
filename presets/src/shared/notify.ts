import { anyCovers, type RunPorts } from "@ng/protocol";

export async function notifyOwner(ports: RunPorts, text: string, key: string): Promise<void> {
  if (anyCovers(ports.self.bounds.canSendTo, "channel:ui:owner")) {
    await ports.notifyOwner({ format: "text", body: text }, key);
  }
}
