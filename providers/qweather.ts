/**
 * 和风天气（QWeather v7）数据源：
 * - 实时天气 + 24h 逐时预报 + 3d 逐日预报 + 空气质量 + 官方气象预警
 * - 需配置 QWEATHER_KEY（通过 X-QW-Api-Key 请求头鉴权）与可选 QWEATHER_HOST
 */
import { computeSolarInfo } from "../solar.ts";
import type {
  AlertLevel,
  DailyForecastPoint,
  FetchJson,
  HourlyForecastPoint,
  WeatherAlert,
  WeatherNow,
  WeatherSnapshot,
} from "../types.ts";

export interface QWeatherOptions {
  apiKey: string;
  host?: string;
  latitude: number;
  longitude: number;
  locationName: string;
  timezone: string;
  fetchJson: FetchJson;
  nowMs?: number;
}

function normalizeHost(host?: string): string {
  const raw = (host ?? "https://devapi.qweather.com").trim().replace(/\/+$/, "");
  if (!raw) return "https://devapi.qweather.com";
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function kmhToMps(v: unknown): number | undefined {
  const n = num(v);
  return n !== undefined ? Number((n / 3.6).toFixed(2)) : undefined;
}

function mapAlertLevel(raw: unknown): AlertLevel {
  const s = String(raw ?? "").toLowerCase();
  if (s.includes("red") || s.includes("红")) return "red";
  if (s.includes("orange") || s.includes("橙")) return "orange";
  if (s.includes("yellow") || s.includes("黄")) return "yellow";
  if (s.includes("blue") || s.includes("蓝")) return "blue";
  return "unknown";
}

export async function fetchQWeather(opts: QWeatherOptions): Promise<WeatherSnapshot> {
  if (!opts.apiKey) {
    throw new Error("QWeather 数据源需要配置 QWEATHER_KEY");
  }
  const nowMs = opts.nowMs ?? Date.now();
  const base = normalizeHost(opts.host);
  const loc = `${opts.longitude.toFixed(2)},${opts.latitude.toFixed(2)}`;
  const init: RequestInit = { headers: { "X-QW-Api-Key": opts.apiKey } };

  const [nowRes, hourlyRes, dailyRes, airRes, warnRes] = await Promise.allSettled([
    opts.fetchJson<Record<string, unknown>>(`${base}/v7/weather/now?location=${loc}`, init),
    opts.fetchJson<Record<string, unknown>>(`${base}/v7/weather/24h?location=${loc}`, init),
    opts.fetchJson<Record<string, unknown>>(`${base}/v7/weather/3d?location=${loc}`, init),
    opts.fetchJson<Record<string, unknown>>(`${base}/v7/air/now?location=${loc}`, init),
    opts.fetchJson<Record<string, unknown>>(`${base}/v7/warning/now?location=${loc}`, init),
  ]);

  if (nowRes.status === "rejected") {
    throw nowRes.reason;
  }
  const nowBody = nowRes.value;
  if (nowBody.code !== undefined && String(nowBody.code) !== "200") {
    throw new Error(`QWeather /v7/weather/now returned code=${String(nowBody.code)}`);
  }

  const rawNow = (nowBody.now ?? {}) as Record<string, unknown>;
  const rawAir =
    airRes.status === "fulfilled" && String(airRes.value.code ?? "200") === "200"
      ? ((airRes.value.now ?? {}) as Record<string, unknown>)
      : {};

  const obsMs = typeof rawNow.obsTime === "string" ? Date.parse(rawNow.obsTime) : NaN;
  const now: WeatherNow = {
    observedAtMs: Number.isFinite(obsMs) ? obsMs : nowMs,
    condition: typeof rawNow.text === "string" ? rawNow.text : undefined,
    temperatureC: num(rawNow.temp),
    feelsLikeC: num(rawNow.feelsLike),
    humidityPct: num(rawNow.humidity),
    pressureHpa: num(rawNow.pressure),
    precipitationMm: num(rawNow.precip),
    windSpeedMps: kmhToMps(rawNow.windSpeed),
    windDir: typeof rawNow.windDir === "string" ? rawNow.windDir : undefined,
    visibilityKm: num(rawNow.vis),
    ...(num(rawAir.aqi) !== undefined ? { aqi: num(rawAir.aqi) } : {}),
    ...(typeof rawAir.category === "string" ? { aqiCategory: rawAir.category } : {}),
    ...(num(rawAir.pm2p5) !== undefined ? { pm25: num(rawAir.pm2p5) } : {}),
    ...(num(rawAir.pm10) !== undefined ? { pm10: num(rawAir.pm10) } : {}),
  };

  const hourly: HourlyForecastPoint[] = [];
  if (hourlyRes.status === "fulfilled" && Array.isArray(hourlyRes.value.hourly)) {
    for (const item of hourlyRes.value.hourly as Array<Record<string, unknown>>) {
      const ms = Date.parse(String(item.fxTime ?? ""));
      if (!Number.isFinite(ms)) continue;
      hourly.push({
        atMs: ms,
        condition: typeof item.text === "string" ? item.text : undefined,
        temperatureC: num(item.temp),
        humidityPct: num(item.humidity),
        precipitationProbabilityPct: num(item.pop),
        precipitationMm: num(item.precip),
        windSpeedMps: kmhToMps(item.windSpeed),
        windDir: typeof item.windDir === "string" ? item.windDir : undefined,
      });
    }
  }

  const daily: DailyForecastPoint[] = [];
  if (dailyRes.status === "fulfilled" && Array.isArray(dailyRes.value.daily)) {
    for (const item of dailyRes.value.daily as Array<Record<string, unknown>>) {
      daily.push({
        date: String(item.fxDate ?? ""),
        dayCondition: typeof item.textDay === "string" ? item.textDay : undefined,
        nightCondition: typeof item.textNight === "string" ? item.textNight : undefined,
        tempMaxC: num(item.tempMax),
        tempMinC: num(item.tempMin),
        windDir: typeof item.windDirDay === "string" ? item.windDirDay : undefined,
      });
    }
  }

  const alerts: WeatherAlert[] = [];
  if (warnRes.status === "fulfilled" && Array.isArray(warnRes.value.warning)) {
    for (const item of warnRes.value.warning as Array<Record<string, unknown>>) {
      alerts.push({
        id: String(item.id ?? `${item.typeName ?? "warn"}-${item.pubTime ?? ""}`),
        title: String(item.title ?? item.typeName ?? "气象预警"),
        type: typeof item.typeName === "string" ? item.typeName : undefined,
        level: mapAlertLevel(item.level ?? item.severityColor ?? item.severity),
        issuedAt: typeof item.pubTime === "string" ? item.pubTime : undefined,
        description: typeof item.text === "string" ? item.text : undefined,
      });
    }
  }

  return {
    provider: "qweather",
    location: {
      name: opts.locationName,
      latitude: opts.latitude,
      longitude: opts.longitude,
      timezone: opts.timezone,
    },
    fetchedAtMs: nowMs,
    now,
    hourly,
    daily,
    alerts,
    solar: computeSolarInfo(nowMs, opts.latitude, opts.longitude),
  };
}
