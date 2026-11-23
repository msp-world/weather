/**
 * 中央气象台 nmc.cn 数据源（免 API Key）：
 * - 实况天气 + 空气质量 AQI + 7 日逐日预报 + 官方四级天气预警
 */
import { computeSolarInfo } from "../solar.ts";
import type {
  AlertLevel,
  DailyForecastPoint,
  FetchJson,
  WeatherAlert,
  WeatherNow,
  WeatherSnapshot,
} from "../types.ts";

const BASE = "https://www.nmc.cn";
const HEADERS = { Referer: "https://www.nmc.cn/" };

type Json = Record<string, unknown>;

function asRecord(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function txt(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s && s !== "9999" ? s : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v !== 9999) return v;
  if (typeof v === "string" && v.trim() !== "" && v.trim() !== "9999") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function stripAdmin(name: string): string {
  return name.trim().replace(/(省|市|自治区|特别行政区|地区|盟|州|县|区)$/u, "");
}

function namesMatch(a: string, b: string): boolean {
  const sa = stripAdmin(a);
  const sb = stripAdmin(b);
  return Boolean(sa && sb && (sa === sb || sa.includes(sb) || sb.includes(sa)));
}

function parseAlertLevel(title: string): AlertLevel {
  if (title.includes("红")) return "red";
  if (title.includes("橙")) return "orange";
  if (title.includes("黄")) return "yellow";
  if (title.includes("蓝")) return "blue";
  return "unknown";
}

export interface NmcOptions {
  province: string;
  city: string;
  stationId?: string;
  latitude?: number;
  longitude?: number;
  timezone: string;
  fetchJson: FetchJson;
  nowMs?: number;
}

export async function fetchNmc(opts: NmcOptions): Promise<WeatherSnapshot> {
  const nowMs = opts.nowMs ?? Date.now();
  let code = opts.stationId?.trim() || "";
  let provinceName = opts.province;
  let cityName = opts.city;

  if (!code) {
    const provinces = asArray(await opts.fetchJson(`${BASE}/rest/province`, { headers: HEADERS }))
      .map(asRecord)
      .filter((x): x is Json => x !== null);
    const prov = provinces.find((p) => namesMatch(txt(p.name) ?? "", opts.province));
    if (!prov || !txt(prov.code)) {
      throw new Error(`中央气象台未找到省份: ${opts.province}`);
    }
    provinceName = txt(prov.name) ?? opts.province;
    const cities = asArray(
      await opts.fetchJson(`${BASE}/rest/province/${encodeURIComponent(String(prov.code))}`, { headers: HEADERS }),
    )
      .map(asRecord)
      .filter((x): x is Json => x !== null);
    const matched = cities.find((c) => namesMatch(txt(c.city) ?? "", opts.city));
    if (!matched || !txt(matched.code)) {
      throw new Error(`中央气象台在 ${provinceName} 下未找到城市: ${opts.city}`);
    }
    code = String(matched.code);
    cityName = txt(matched.city) ?? opts.city;
  }

  const [weatherPayload, alarmPayload] = await Promise.all([
    opts.fetchJson<Json>(`${BASE}/rest/weather?stationid=${encodeURIComponent(code)}`, { headers: HEADERS }),
    opts.fetchJson<unknown>(`${BASE}/rest/findAlarm?pageNo=1&pageSize=30`, { headers: HEADERS }).catch(() => null),
  ]);

  const data = asRecord(weatherPayload.data) ?? weatherPayload;
  const real = asRecord(data.real) ?? {};
  const realWeather = asRecord(real.weather) ?? {};
  const realWind = asRecord(real.wind) ?? {};
  const air = asRecord(data.air) ?? {};
  const predict = asRecord(data.predict) ?? {};

  const now: WeatherNow = {
    observedAtMs: nowMs,
    condition: txt(realWeather.info),
    temperatureC: num(realWeather.temperature),
    feelsLikeC: num(realWeather.feelst),
    humidityPct: num(realWeather.humidity),
    pressureHpa: num(realWeather.airpressure),
    precipitationMm: num(realWeather.rain),
    windSpeedMps: num(realWind.speed),
    windDir: txt(realWind.direct),
    aqi: num(air.aqi),
    aqiCategory: txt(air.text),
  };

  const daily: DailyForecastPoint[] = [];
  for (const item of asArray(predict.detail).map(asRecord).filter((x): x is Json => x !== null)) {
    const day = asRecord(item.day);
    const night = asRecord(item.night);
    daily.push({
      date: txt(item.date) ?? "",
      dayCondition: txt(asRecord(day?.weather)?.info),
      nightCondition: txt(asRecord(night?.weather)?.info),
      tempMaxC: num(asRecord(day?.weather)?.temperature),
      tempMinC: num(asRecord(night?.weather)?.temperature),
      windDir: txt(asRecord(day?.wind)?.direct),
    });
  }

  const alarmRoot = asRecord(alarmPayload);
  const alarmData = asRecord(alarmRoot?.data);
  const rawAlarms = asArray(alarmData?.page ? asRecord(alarmData.page)?.list : alarmData?.list ?? alarmPayload);
  const alerts: WeatherAlert[] = [];
  for (const raw of rawAlarms.map(asRecord).filter((x): x is Json => x !== null)) {
    const title = txt(raw.title) ?? "";
    if (!title) continue;
    if (!namesMatch(title, cityName) && !namesMatch(title, provinceName)) continue;
    alerts.push({
      id: txt(raw.alertid) ?? title,
      title,
      type: txt(raw.type),
      level: parseAlertLevel(title),
      issuedAt: txt(raw.issuetime),
      description: txt(raw.description),
    });
  }

  const solar =
    opts.latitude !== undefined && opts.longitude !== undefined
      ? computeSolarInfo(nowMs, opts.latitude, opts.longitude)
      : undefined;

  return {
    provider: "nmc",
    location: {
      name: `${provinceName} ${cityName}`,
      province: provinceName,
      city: cityName,
      latitude: opts.latitude,
      longitude: opts.longitude,
      timezone: opts.timezone,
    },
    fetchedAtMs: nowMs,
    now,
    hourly: [],
    daily,
    alerts,
    solar,
  };
}
