/**
 * Weather MSP 节点启动入口。
 *
 * 环境变量：
 *   WEATHER_PROVIDER   openmeteo（默认）、nmc 或 qweather
 *   WEATHER_PROVINCE   省份（默认 北京市）
 *   WEATHER_CITY       城市（默认 北京）
 *   WEATHER_STATION_ID 中央气象台站号（可选）
 *   QWEATHER_KEY       和风天气 API Key（provider=qweather 时必填）
 *   QWEATHER_HOST      和风天气 API Host（可选，默认 https://devapi.qweather.com）
 *   WEATHER_LAT        纬度（默认 39.9042）
 *   WEATHER_LON        经度（默认 116.4074）
 *   WEATHER_TZ         时区（默认 Asia/Shanghai）
 */
import { MSPNode, installShutdownHooks, mspOptionsFromEnv } from "../shared/msp.ts";
import { WeatherWorld } from "./world.ts";
import type { WeatherProviderId } from "./types.ts";

export async function startWeatherNode(): Promise<{ node: MSPNode; world: WeatherWorld }> {
  const node = new MSPNode(process.env.WEATHER_NODE_ID || "weather", mspOptionsFromEnv("WEATHER"));
  const rawProvider = process.env.WEATHER_PROVIDER;
  const provider: WeatherProviderId =
    rawProvider === "nmc" ? "nmc" : rawProvider === "qweather" ? "qweather" : "openmeteo";
  const world = new WeatherWorld({
    config: {
      provider,
      province: process.env.WEATHER_PROVINCE || "北京市",
      city: process.env.WEATHER_CITY || "北京",
      nmcStationId: process.env.WEATHER_STATION_ID || "",
      qweatherKey: process.env.QWEATHER_KEY || "",
      qweatherHost: process.env.QWEATHER_HOST || undefined,
      latitude: process.env.WEATHER_LAT ? Number(process.env.WEATHER_LAT) : 39.9042,
      longitude: process.env.WEATHER_LON ? Number(process.env.WEATHER_LON) : 116.4074,
      timezone: process.env.WEATHER_TZ || "Asia/Shanghai",
    },
  });

  world.attach(node);
  const ep = await node.start();
  world.start();
  console.log(`[weather] MSP node "${node.nodeId}" (${provider}) listening on ${ep.host}:${ep.port}`);
  return { node, world };
}

if (import.meta.main) {
  const { node, world } = await startWeatherNode();
  installShutdownHooks(() => {
    world.stop();
    node.stop();
  });
}
