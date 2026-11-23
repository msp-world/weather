/**
 * 天气 / 空气质量 / 预警 / 昼夜变化检测（融合 realtime-weather 与 weather）。
 */
import type { AlertLevel, WeatherAlert, WeatherSnapshot } from "./types.ts";

export interface WeatherChange {
  kind: "condition" | "temperature" | "aqi" | "wind" | "alert" | "solar";
  summary: string;
  detail: Record<string, unknown>;
}

const LEVEL_RANK: Record<AlertLevel, number> = {
  unknown: 0,
  blue: 1,
  yellow: 2,
  orange: 3,
  red: 4,
};

export function alertSignature(alerts: readonly WeatherAlert[]): string {
  return [...alerts]
    .sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || a.id.localeCompare(b.id))
    .map((a) => `${a.id}:${a.level}:${a.title}`)
    .join("|");
}

export function detectWeatherChanges(
  prev: WeatherSnapshot | null,
  next: WeatherSnapshot,
): WeatherChange[] {
  if (!prev) return [];
  const changes: WeatherChange[] = [];

  const pn = prev.now;
  const nn = next.now;
  if (pn && nn) {
    if (pn.condition && nn.condition && pn.condition !== nn.condition) {
      changes.push({
        kind: "condition",
        summary: `天气现象变化：${pn.condition} → ${nn.condition}`,
        detail: { from: pn.condition, to: nn.condition },
      });
    }
    if (
      typeof pn.temperatureC === "number" &&
      typeof nn.temperatureC === "number" &&
      Math.abs(nn.temperatureC - pn.temperatureC) >= 3
    ) {
      const delta = Number((nn.temperatureC - pn.temperatureC).toFixed(1));
      changes.push({
        kind: "temperature",
        summary: `气温显著变化：${pn.temperatureC}°C → ${nn.temperatureC}°C (${delta > 0 ? "+" : ""}${delta}°C)`,
        detail: { from: pn.temperatureC, to: nn.temperatureC, delta },
      });
    }
    if (pn.aqiCategory && nn.aqiCategory && pn.aqiCategory !== nn.aqiCategory) {
      changes.push({
        kind: "aqi",
        summary: `空气质量变化：${pn.aqiCategory} → ${nn.aqiCategory}`,
        detail: { from: pn.aqiCategory, to: nn.aqiCategory, aqi: nn.aqi ?? null },
      });
    }
    if (
      typeof pn.windSpeedMps === "number" &&
      typeof nn.windSpeedMps === "number" &&
      Math.abs(nn.windSpeedMps - pn.windSpeedMps) >= 4
    ) {
      changes.push({
        kind: "wind",
        summary: `风速变化：${pn.windSpeedMps} m/s → ${nn.windSpeedMps} m/s`,
        detail: { from: pn.windSpeedMps, to: nn.windSpeedMps },
      });
    }
  }

  if (alertSignature(prev.alerts) !== alertSignature(next.alerts)) {
    changes.push({
      kind: "alert",
      summary: next.alerts.length > 0 ? `生效预警变更（当前 ${next.alerts.length} 条）` : "天气预警已解除",
      detail: { prevCount: prev.alerts.length, nextCount: next.alerts.length, alerts: next.alerts },
    });
  }

  if (prev.solar && next.solar && prev.solar.isDaylight !== next.solar.isDaylight) {
    changes.push({
      kind: "solar",
      summary: next.solar.isDaylight ? "天亮了（日出）" : "天黑了（日落）",
      detail: { isDaylight: next.solar.isDaylight, sunriseIso: next.solar.sunriseIso, sunsetIso: next.solar.sunsetIso },
    });
  }

  return changes;
}
