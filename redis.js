import Redis from "ioredis";

export const redis = new Redis(process.env.REDIS_URL, {
  family: 0,
  maxRetriesPerRequest: 3,
});

redis.on("error", (err) => console.error("redis error", err.message));
