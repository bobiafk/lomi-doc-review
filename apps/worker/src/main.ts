import { Redis } from "ioredis";
import { loadEnv } from "./env.js";

const env = loadEnv();
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

await redis.ping();
console.log("worker connected to redis");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void redis.quit().then(() => process.exit(0));
  });
}
