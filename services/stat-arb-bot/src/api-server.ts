/** Re-export the modular API server. The previous monolithic version split
 *  into `services/stat-arb-bot/src/api/*` during the dashboard overhaul. */

export { createApiServer } from "./api/server";
export type { ApiServerOptions } from "./api/server";
