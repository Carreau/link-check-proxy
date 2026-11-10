import { handleRequest } from "./api.js";
import { DEFAULT_CONFIG } from "./config.js";
import { runTick } from "./scheduler.js";
import { Store, type Db } from "./store.js";

export interface Env {
  DB: D1Database;
  ADMIN_TOKEN?: string;
}

const store = (env: Env) => new Store(env.DB as unknown as Db);

export default {
  async fetch(req, env): Promise<Response> {
    return handleRequest(req, {
      store: store(env),
      cfg: DEFAULT_CONFIG,
      nowMs: Date.now,
      adminToken: env.ADMIN_TOKEN,
    });
  },

  async scheduled(controller, env, ctx): Promise<void> {
    const when = new Date(controller.scheduledTime);
    // Drop long-unrequested URLs once a day.
    const dropIdle = when.getUTCHours() === 3 && when.getUTCMinutes() === 0;
    // Full-table stats for the admin overview, hourly.
    const refreshStats = when.getUTCMinutes() === 0;
    ctx.waitUntil(
      runTick({
        store: store(env),
        fetchFn: (input, init) => fetch(input, init),
        cfg: DEFAULT_CONFIG,
        nowMs: controller.scheduledTime,
        dropIdle,
        refreshStats,
      }).then(
        (r) => console.log("tick", JSON.stringify(r)),
        (e) => console.error("tick failed", e),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
