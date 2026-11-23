/**
 * 缝合版 Weather + Realtime Weather MSP World：
 * - 整合多源天气（NMC / Open-Meteo）、空气质量（AQI / PM2.5）、48h 逐时与多日预报、CMA 四级预警、日出日落（Solar）与变化检测
 * - 工具：weather_now, weather_forecast, weather_alerts, weather_solar
 * - 信号：weather.now, weather.forecast, weather.alert, weather.changed, weather.solar
 */
import type { MSPNode } from "../shared/msp.ts";
import { detectWeatherChanges } from "./diff.ts";
import { fetchNmc } from "./providers/nmc.ts";
import { fetchOpenMeteo } from "./providers/openmeteo.ts";
import { fetchQWeather } from "./providers/qweather.ts";
import { computeSolarInfo } from "./solar.ts";
import type { FetchJson, HourlyForecastPoint, WeatherProviderId, WeatherSnapshot } from "./types.ts";

export interface WeatherConfig {
  provider: WeatherProviderId;
  province: string;
  city: string;
  nmcStationId?: string;
  qweatherKey?: string;
  qweatherHost?: string;
  latitude: number;
  longitude: number;
  timezone: string;
  pollIntervalMs?: number;
  cacheTtlMs?: number;
}

export interface WeatherWorldOptions {
  config: WeatherConfig;
  fetchJson?: FetchJson;
  fetchSnapshot?: (cfg: WeatherConfig, nowMs: number) => Promise<WeatherSnapshot>;
  now?: () => number;
}

const DEFAULT_CACHE_TTL_MS = 10 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 15 * 60_000;
const TARGET_HORIZONS = [1, 6, 12, 24, 48];

function defaultFetchJson(timeoutMs = 10_000): FetchJson {
  return async <T = unknown>(url: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url}`);
    }
    return (await res.json()) as T;
  };
}

function pickHorizons(hourly: readonly HourlyForecastPoint[], nowMs: number): Record<string, HourlyForecastPoint | null> {
  const out: Record<string, HourlyForecastPoint | null> = {};
  for (const h of TARGET_HORIZONS) {
    const targetMs = nowMs + h * 3600_000;
    let best: HourlyForecastPoint | null = null;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const pt of hourly) {
      const diff = Math.abs(pt.atMs - targetMs);
      if (diff <= 90 * 60_000 && diff < bestDiff) {
        best = pt;
        bestDiff = diff;
      }
    }
    out[`${h}h`] = best;
  }
  return out;
}

export class WeatherWorld {
  private readonly cfg: Required<WeatherConfig>;
  private readonly fetchJson: FetchJson;
  private readonly customFetch?: (cfg: WeatherConfig, nowMs: number) => Promise<WeatherSnapshot>;
  private readonly now: () => number;
  private node: MSPNode | null = null;
  private snapshot: WeatherSnapshot | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<WeatherSnapshot> | null = null;

  constructor(options: WeatherWorldOptions) {
    this.now = options.now ?? Date.now;
    this.fetchJson = options.fetchJson ?? defaultFetchJson();
    this.customFetch = options.fetchSnapshot;
    this.cfg = {
      provider: options.config.provider,
      province: options.config.province,
      city: options.config.city,
      nmcStationId: options.config.nmcStationId ?? "",
      qweatherKey: options.config.qweatherKey ?? "",
      qweatherHost: options.config.qweatherHost ?? "https://devapi.qweather.com",
      latitude: options.config.latitude,
      longitude: options.config.longitude,
      timezone: options.config.timezone,
      pollIntervalMs: options.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      cacheTtlMs: options.config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
    };
  }

  attach(node: MSPNode): void {
    this.node = node;
    node.declareSignal("weather.now", "当前实况天气与空气质量快照");
    node.declareSignal("weather.forecast", "未来逐时与多日天气预报");
    node.declareSignal("weather.alert", "气象预警新增、变更或解除");
    node.declareSignal("weather.changed", "天气现象、气温、风速、AQI 或预警变化事件");
    node.declareSignal("weather.solar", "日出/日落昼夜状态切换");

    node.tool(
      "weather_now",
      "读取配置地点的当前天气实况、空气质量（AQI/PM2.5）、生效预警数与昼夜状态",
      async (args) => this.toolNow(args),
      {
        type: "object",
        additionalProperties: false,
        properties: {
          refresh: { type: "boolean", description: "是否强制跳过缓存立即刷新", default: false },
        },
      },
    );

    node.tool(
      "weather_forecast",
      "读取配置地点未来 1/6/12/24/48 小时及多日天气预报",
      async (args) => this.toolForecast(args),
      {
        type: "object",
        additionalProperties: false,
        properties: {
          refresh: { type: "boolean", default: false },
        },
      },
    );

    node.tool(
      "weather_alerts",
      "读取配置地点当前生效的天气预警（蓝/黄/橙/红四级）",
      async (args) => this.toolAlerts(args),
      {
        type: "object",
        additionalProperties: false,
        properties: {
          refresh: { type: "boolean", default: false },
        },
      },
    );

    node.tool(
      "weather_solar",
      "计算配置经纬度的日出、日落时刻与当前是否处于白天",
      async () => this.toolSolar(),
      { type: "object", additionalProperties: false, properties: {} },
    );
  }

  start(): void {
    if (this.timer) return;
    void this.refreshAndPublish().catch(() => {
      /* 启动首轮失败不崩溃，等待下一轮或工具触发 */
    });
    if (this.cfg.pollIntervalMs > 0) {
      this.timer = setInterval(() => {
        void this.refreshAndPublish().catch(() => {});
      }, this.cfg.pollIntervalMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async refreshAndPublish(): Promise<WeatherSnapshot> {
    const prev = this.snapshot;
    const next = await this.fetchFresh();
    if (!this.node) return next;

    this.node.publish("weather.now", {
      provider: next.provider,
      location: next.location,
      now: next.now ?? null,
      solar: next.solar ?? null,
    });
    this.node.publish("weather.forecast", {
      provider: next.provider,
      location: next.location,
      horizons: pickHorizons(next.hourly, next.fetchedAtMs),
      daily: next.daily,
    });

    const changes = detectWeatherChanges(prev, next);
    for (const ch of changes) {
      this.node.publish("weather.changed", {
        kind: ch.kind,
        summary: ch.summary,
        ...ch.detail,
      });
      if (ch.kind === "alert") {
        this.node.publish("weather.alert", {
          location: next.location,
          alerts: next.alerts,
          summary: ch.summary,
        });
      }
      if (ch.kind === "solar") {
        this.node.publish("weather.solar", {
          location: next.location,
          ...ch.detail,
        });
      }
    }
    return next;
  }

  private async ensureSnapshot(forceRefresh = false): Promise<WeatherSnapshot> {
    const nowMs = this.now();
    if (!forceRefresh && this.snapshot && nowMs - this.snapshot.fetchedAtMs < this.cfg.cacheTtlMs) {
      return this.snapshot;
    }
    return this.fetchFresh();
  }

  private async fetchFresh(): Promise<WeatherSnapshot> {
    if (this.inflight) return this.inflight;
    const task = (async () => {
      const nowMs = this.now();
      let snap: WeatherSnapshot;
      if (this.customFetch) {
        snap = await this.customFetch(this.cfg, nowMs);
      } else if (this.cfg.provider === "nmc") {
        snap = await fetchNmc({
          province: this.cfg.province,
          city: this.cfg.city,
          stationId: this.cfg.nmcStationId,
          latitude: this.cfg.latitude,
          longitude: this.cfg.longitude,
          timezone: this.cfg.timezone,
          fetchJson: this.fetchJson,
          nowMs,
        });
      } else if (this.cfg.provider === "qweather") {
        snap = await fetchQWeather({
          apiKey: this.cfg.qweatherKey,
          host: this.cfg.qweatherHost,
          latitude: this.cfg.latitude,
          longitude: this.cfg.longitude,
          locationName: `${this.cfg.province} ${this.cfg.city}`.trim(),
          timezone: this.cfg.timezone,
          fetchJson: this.fetchJson,
          nowMs,
        });
      } else {
        snap = await fetchOpenMeteo({
          latitude: this.cfg.latitude,
          longitude: this.cfg.longitude,
          locationName: `${this.cfg.province} ${this.cfg.city}`.trim(),
          timezone: this.cfg.timezone,
          fetchJson: this.fetchJson,
          nowMs,
        });
      }
      this.snapshot = snap;
      return snap;
    })();
    this.inflight = task;
    try {
      return await task;
    } finally {
      this.inflight = null;
    }
  }

  private async toolNow(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const snap = await this.ensureSnapshot(args.refresh === true);
    return {
      provider: snap.provider,
      location: snap.location,
      fetched_at: new Date(snap.fetchedAtMs).toISOString(),
      now: snap.now ?? null,
      solar: snap.solar ?? null,
      active_alerts_count: snap.alerts.length,
    };
  }

  private async toolForecast(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const snap = await this.ensureSnapshot(args.refresh === true);
    return {
      provider: snap.provider,
      location: snap.location,
      fetched_at: new Date(snap.fetchedAtMs).toISOString(),
      horizons: pickHorizons(snap.hourly, snap.fetchedAtMs),
      daily: snap.daily,
    };
  }

  private async toolAlerts(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const snap = await this.ensureSnapshot(args.refresh === true);
    return {
      provider: snap.provider,
      location: snap.location,
      fetched_at: new Date(snap.fetchedAtMs).toISOString(),
      count: snap.alerts.length,
      alerts: snap.alerts,
      notes: snap.notes ?? [],
    };
  }

  private toolSolar(): Record<string, unknown> {
    const nowMs = this.now();
    const solar = computeSolarInfo(nowMs, this.cfg.latitude, this.cfg.longitude);
    return {
      location: {
        name: `${this.cfg.province} ${this.cfg.city}`.trim(),
        latitude: this.cfg.latitude,
        longitude: this.cfg.longitude,
        timezone: this.cfg.timezone,
      },
      now: new Date(nowMs).toISOString(),
      solar,
    };
  }
}
