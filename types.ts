export type WeatherProviderId = "openmeteo" | "nmc" | "qweather";

export type AlertLevel = "blue" | "yellow" | "orange" | "red" | "unknown";

export interface WeatherLocation {
  name: string;
  province?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  timezone: string;
}

export interface WeatherNow {
  observedAtMs?: number;
  condition?: string;
  temperatureC?: number;
  feelsLikeC?: number;
  humidityPct?: number;
  pressureHpa?: number;
  precipitationMm?: number;
  windSpeedMps?: number;
  windDir?: string;
  visibilityKm?: number;
  uvIndex?: number;
  aqi?: number;
  aqiCategory?: string;
  pm25?: number;
  pm10?: number;
}

export interface HourlyForecastPoint {
  atMs: number;
  condition?: string;
  temperatureC?: number;
  humidityPct?: number;
  precipitationProbabilityPct?: number;
  precipitationMm?: number;
  windSpeedMps?: number;
  windDir?: string;
}

export interface DailyForecastPoint {
  date: string;
  dayCondition?: string;
  nightCondition?: string;
  tempMaxC?: number;
  tempMinC?: number;
  precipitationProbabilityPct?: number;
  windDir?: string;
}

export interface WeatherAlert {
  id: string;
  title: string;
  type?: string;
  level: AlertLevel;
  issuedAt?: string;
  description?: string;
}

export interface SolarInfo {
  sunriseIso: string | null;
  sunsetIso: string | null;
  isDaylight: boolean;
}

export interface WeatherSnapshot {
  provider: WeatherProviderId;
  location: WeatherLocation;
  fetchedAtMs: number;
  now?: WeatherNow;
  hourly: HourlyForecastPoint[];
  daily: DailyForecastPoint[];
  alerts: WeatherAlert[];
  solar?: SolarInfo;
  notes?: string[];
}

export type FetchJson = <T = unknown>(url: string, init?: RequestInit) => Promise<T>;
