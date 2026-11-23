/**
 * Open-Meteo 数据源（免 API Key）：
 * - 实时天气 + 48 小时逐时预报 + 逐日预报 + UV / 能见度
 * - 空气质量（PM2.5 / PM10 / US AQI）
 */
import { computeSolarInfo } from "../solar.ts";
import type {
  DailyForecastPoint,
  FetchJson,
  HourlyForecastPoint,
  WeatherNow,
  WeatherSnapshot,
} from "../types.ts";

const FORECAST_ENDPOINT = "https://api.open-meteo.com/v1/forecast";
const AIR_ENDPOINT = "https://air-quality-api.open-meteo.com/v1/air-quality";

const WMO: Record<number, string> = {
  0: "晴",
  1: "大部晴朗",
  2: "多云",
  3: "阴",
  45: "雾",
  48: "雾凇",
  51: "小毛毛雨",
  53: "中毛毛雨",
  55: "大毛毛雨",
  56: "冻毛毛雨",
  57: "强冻毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  66: "冻雨",
  67: "强冻雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "雪粒",
  80: "小阵雨",
  81: "中阵雨",
  82: "强阵雨",
  85: "小阵雪",
  86: "强阵雪",
  95: "雷暴",
  96: "雷暴伴小冰雹",
  99: "雷暴伴大冰雹",
};

function wmoCondition(code: unknown): string | undefined {
  const n = typeof code === "number" ? code : Number(code);
  return Number.isFinite(n) ? WMO[n] ?? `WMO ${n}` : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function windDirFromDeg(degVal: unknown): string | undefined {
  const deg = num(degVal);
  if (deg === undefined) return undefined;
  const dirs = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"];
  const idx = Math.round(((deg % 360) + 360) % 360 / 45) % 8;
  return `${dirs[idx]}风`;
}

export function aqiCategoryFromUsAqi(aqi: number): string {
  if (aqi <= 50) return "优";
  if (aqi <= 100) return "良";
  if (aqi <= 150) return "轻度污染";
  if (aqi <= 200) return "中度污染";
  if (aqi <= 300) return "重度污染";
  return "严重污染";
}

export interface OpenMeteoOptions {
  latitude: number;
  longitude: number;
  locationName: string;
  timezone: string;
  fetchJson: FetchJson;
  nowMs?: number;
}

export async function fetchOpenMeteo(opts: OpenMeteoOptions): Promise<WeatherSnapshot> {
  const nowMs = opts.nowMs ?? Date.now();
  const tz = encodeURIComponent(opts.timezone);
  const forecastUrl =
    `${FORECAST_ENDPOINT}?latitude=${opts.latitude}&longitude=${opts.longitude}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,pressure_msl,wind_speed_10m,wind_direction_10m` +
    `&hourly=temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_direction_10m,visibility,uv_index` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&wind_speed_unit=ms&forecast_days=5&timezone=${tz}`;

  const airUrl =
    `${AIR_ENDPOINT}?latitude=${opts.latitude}&longitude=${opts.longitude}` +
    `&current=us_aqi,pm2_5,pm10&timezone=${tz}`;

  const [forecastRes, airRes] = await Promise.allSettled([
    opts.fetchJson<Record<string, unknown>>(forecastUrl),
    opts.fetchJson<Record<string, unknown>>(airUrl),
  ]);

  if (forecastRes.status === "rejected") {
    throw forecastRes.reason;
  }

  const payload = forecastRes.value;
  const current = (payload.current ?? {}) as Record<string, unknown>;
  const airCurrent =
    airRes.status === "fulfilled"
      ? (((airRes.value as Record<string, unknown>).current ?? {}) as Record<string, unknown>)
      : {};

  const aqi = num(airCurrent.us_aqi);
  const now: WeatherNow = {
    observedAtMs: nowMs,
    condition: wmoCondition(current.weather_code),
    temperatureC: num(current.temperature_2m),
    feelsLikeC: num(current.apparent_temperature),
    humidityPct: num(current.relative_humidity_2m),
    pressureHpa: num(current.pressure_msl),
    precipitationMm: num(current.precipitation),
    windSpeedMps: num(current.wind_speed_10m),
    windDir: windDirFromDeg(current.wind_direction_10m),
    ...(aqi !== undefined ? { aqi, aqiCategory: aqiCategoryFromUsAqi(aqi) } : {}),
    ...(num(airCurrent.pm2_5) !== undefined ? { pm25: num(airCurrent.pm2_5) } : {}),
    ...(num(airCurrent.pm10) !== undefined ? { pm10: num(airCurrent.pm10) } : {}),
  };

  const hourlyObj = (payload.hourly ?? {}) as Record<string, unknown[]>;
  const hTimes = Array.isArray(hourlyObj.time) ? hourlyObj.time : [];
  const hourly: HourlyForecastPoint[] = [];
  for (let i = 0; i < hTimes.length; i++) {
    const ms = Date.parse(String(hTimes[i]));
    if (!Number.isFinite(ms)) continue;
    hourly.push({
      atMs: ms,
      condition: wmoCondition(hourlyObj.weather_code?.[i]),
      temperatureC: num(hourlyObj.temperature_2m?.[i]),
      humidityPct: num(hourlyObj.relative_humidity_2m?.[i]),
      precipitationProbabilityPct: num(hourlyObj.precipitation_probability?.[i]),
      precipitationMm: num(hourlyObj.precipitation?.[i]),
      windSpeedMps: num(hourlyObj.wind_speed_10m?.[i]),
      windDir: windDirFromDeg(hourlyObj.wind_direction_10m?.[i]),
    });
    if (i === 0) {
      const visM = num(hourlyObj.visibility?.[0]);
      if (visM !== undefined) now.visibilityKm = Number((visM / 1000).toFixed(1));
      const uv = num(hourlyObj.uv_index?.[0]);
      if (uv !== undefined) now.uvIndex = uv;
    }
  }

  const dailyObj = (payload.daily ?? {}) as Record<string, unknown[]>;
  const dTimes = Array.isArray(dailyObj.time) ? dailyObj.time : [];
  const daily: DailyForecastPoint[] = [];
  for (let i = 0; i < dTimes.length; i++) {
    daily.push({
      date: String(dTimes[i]),
      dayCondition: wmoCondition(dailyObj.weather_code?.[i]),
      tempMaxC: num(dailyObj.temperature_2m_max?.[i]),
      tempMinC: num(dailyObj.temperature_2m_min?.[i]),
      precipitationProbabilityPct: num(dailyObj.precipitation_probability_max?.[i]),
    });
  }

  return {
    provider: "openmeteo",
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
    alerts: [],
    solar: computeSolarInfo(nowMs, opts.latitude, opts.longitude),
    notes: ["Open-Meteo 公开接口不提供气象预警，如需国内官方预警请使用 nmc 数据源。"],
  };
}
