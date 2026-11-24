// A real Node backend for the happy-dom UI regression. All data is created by the isolated test fixture.
import { bootDesk, cleanupAll } from "../helpers";

const desk = await bootDesk({ port: 0 });
const { url } = await desk.server.listen();
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await cleanupAll();
  process.exit(0);
}
process.on("message", async (message: { id: number; kind: "records" | "stop" }) => {
  if (message.kind === "stop") { await close(); return; }
  try {
    await desk.kernel.idle();
    const records = desk.server.desk.timeline("desk", {}).items.filter(item => item.kind === "user_chat");
    process.send?.({ id: message.id, records });
  } catch (error) { process.send?.({ id: message.id, error: String(error) }); }
});
process.on("disconnect", () => { void close(); });
process.on("SIGTERM", () => { void close(); });
process.send?.({ url });
