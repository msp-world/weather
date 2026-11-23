/**
 * 纯 TypeScript 太阳位置与日出日落计算（基于 NOAA 近似公式，零第三方依赖）。
 */
import type { SolarInfo } from "./types.ts";

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const DAY_MS = 86_400_000;
const J1970 = 2440588;
const J2000 = 2451545;

function toJulian(ms: number): number {
  return ms / DAY_MS - 0.5 + J1970;
}

function fromJulian(j: number): number {
  return (j + 0.5 - J1970) * DAY_MS;
}

function solarMeanAnomaly(d: number): number {
  return RAD * (357.5291 + 0.98560028 * d);
}

function eclipticLongitude(M: number): number {
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const P = RAD * 102.9372;
  return M + C + P + Math.PI;
}

function declination(L: number): number {
  const e = RAD * 23.4397;
  return Math.asin(Math.sin(e) * Math.sin(L));
}

function julianCycle(d: number, lw: number): number {
  return Math.round(d - 0.0009 - lw / (2 * Math.PI));
}

function approxTransit(Ht: number, lw: number, n: number): number {
  return 0.0009 + (Ht + lw) / (2 * Math.PI) + n;
}

function solarTransitJ(ds: number, M: number, L: number): number {
  return J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
}

function hourAngle(h: number, phi: number, d: number): number {
  const cosH = (Math.sin(h) - Math.sin(phi) * Math.sin(d)) / (Math.cos(phi) * Math.cos(d));
  if (cosH < -1 || cosH > 1) return Number.NaN;
  return Math.acos(cosH);
}

export function computeSolarInfo(nowMs: number, latitude: number, longitude: number): SolarInfo {
  const lw = RAD * -longitude;
  const phi = RAD * latitude;
  const d = toJulian(nowMs) - J2000;
  const n = julianCycle(d, lw);
  const ds = approxTransit(0, lw, n);
  const M = solarMeanAnomaly(ds);
  const L = eclipticLongitude(M);
  const dec = declination(L);
  const jNoon = solarTransitJ(ds, M, L);
  const h0 = RAD * -0.833;
  const w = hourAngle(h0, phi, dec);

  if (Number.isNaN(w)) {
    const polarDay = (latitude >= 0 && dec > 0) || (latitude < 0 && dec < 0);
    return { sunriseIso: null, sunsetIso: null, isDaylight: polarDay };
  }

  const jSet = solarTransitJ(approxTransit(w, lw, n), M, L);
  const jRise = jNoon - (jSet - jNoon);
  const riseMs = fromJulian(jRise);
  const setMs = fromJulian(jSet);

  return {
    sunriseIso: new Date(riseMs).toISOString(),
    sunsetIso: new Date(setMs).toISOString(),
    isDaylight: nowMs >= riseMs && nowMs < setMs,
  };
}
