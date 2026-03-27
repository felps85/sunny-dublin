import SunCalc from "suncalc";
import type { ForecastHour, Interval, Pub, SunnyHour } from "../types";
import { angleDiffDeg, wrap360 } from "./geo";

const RAD2DEG = 180 / Math.PI;

type ForecastSnapshot = {
  cloudCoverPct?: number;
  weatherCode?: number;
};

function sunBearingFromNorthDeg(pos: { azimuth: number }) {
  // SunCalc azimuth is measured from South, positive West (radians).
  // Convert to a "bearing from North, clockwise" in degrees.
  // azimuth 0 => South => 180° bearing.
  return wrap360(pos.azimuth * RAD2DEG + 180);
}

function sunAltitudeDeg(pos: { altitude: number }) {
  return pos.altitude * RAD2DEG;
}

export function computeFrontSunnyHours(params: {
  pub: Pub;
  forecast: ForecastHour[];
  /**
   * If set, uses this bearing instead of pub.frontBearingDeg (useful for user calibration).
   */
  frontBearingDegOverride?: number;
  /**
   * How strict "front lit" is (0..180). Default 80 is a bit more conservative
   * so very glancing light does not count as a sunny facade.
   */
  maxAngleFromFrontDeg?: number;
  /**
   * Cloud cover threshold (0..100). Default 40.
   */
  maxCloudCoverPct?: number;
  /**
   * Minimum sun altitude needed to clear nearby street/building shade.
   */
  minSunAltitudeDeg?: number;
}) {
  const maxAngle = params.maxAngleFromFrontDeg ?? 80;
  const maxCloud = params.maxCloudCoverPct ?? 40;
  const minSunAltitudeDeg = params.minSunAltitudeDeg ?? 0;
  const frontBearing = params.frontBearingDegOverride ?? params.pub.frontBearingDeg;
  if (frontBearing === undefined) return [] as SunnyHour[];

  const hours: SunnyHour[] = [];
  for (const hour of params.forecast) {
    const pos = SunCalc.getPosition(hour.time, params.pub.lat, params.pub.lon);
    const altitude = sunAltitudeDeg(pos);
    const bearing = sunBearingFromNorthDeg(pos);

    const inFront = angleDiffDeg(bearing, frontBearing) <= maxAngle;
    const hasSun = altitude > minSunAltitudeDeg;
    const skyOk = supportsDirectSun({
      cloudCoverPct: hour.cloudCoverPct,
      weatherCode: hour.weatherCode,
      maxCloudCoverPct: maxCloud
    });

    const isFrontSunny = hasSun && inFront && skyOk;
    hours.push({
      time: hour.time,
      isFrontSunny,
      sunAltitudeDeg: altitude,
      sunBearingDeg: bearing,
      cloudCoverPct: hour.cloudCoverPct
    });
  }
  return hours;
}

export function makeTimeGrid(params: { start: Date; minutesStep: number; steps: number }) {
  const { start, minutesStep, steps } = params;
  const stepMs = minutesStep * 60_000;
  const startMs = start.getTime();
  const first = Math.ceil(startMs / stepMs) * stepMs;
  const out: Date[] = [];
  for (let i = 0; i < steps; i++) out.push(new Date(first + i * stepMs));
  return out;
}

function interpolateNumber(a: number | undefined, b: number | undefined, ratio: number) {
  if (a === undefined && b === undefined) return undefined;
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a + (b - a) * ratio;
}

function forecastSnapshotAtTime(forecast: ForecastHour[], t: Date): ForecastSnapshot {
  if (!forecast.length) return {};
  if (forecast.length === 1) {
    const only = forecast[0]!;
    return {
      cloudCoverPct: only.cloudCoverPct,
      weatherCode: only.weatherCode
    };
  }

  const target = t.getTime();
  const first = forecast[0]!;
  if (target <= first.time.getTime()) {
    return {
      cloudCoverPct: first.cloudCoverPct,
      weatherCode: first.weatherCode
    };
  }

  for (let i = 1; i < forecast.length; i++) {
    const previous = forecast[i - 1]!;
    const next = forecast[i]!;
    const nextTime = next.time.getTime();
    if (target > nextTime) continue;

    const previousTime = previous.time.getTime();
    const span = Math.max(1, nextTime - previousTime);
    const ratio = Math.max(0, Math.min(1, (target - previousTime) / span));
    return {
      cloudCoverPct: interpolateNumber(previous.cloudCoverPct, next.cloudCoverPct, ratio),
      weatherCode: ratio < 0.5 ? previous.weatherCode : next.weatherCode
    };
  }

  const last = forecast[forecast.length - 1]!;
  return {
    cloudCoverPct: last.cloudCoverPct,
    weatherCode: last.weatherCode
  };
}

function blocksDirectSunFromWeatherCode(weatherCode?: number) {
  if (weatherCode === undefined) return false;
  if (weatherCode === 45 || weatherCode === 48) return true;
  if (weatherCode >= 51 && weatherCode <= 67) return true;
  if (weatherCode >= 71 && weatherCode <= 77) return true;
  if (weatherCode >= 80 && weatherCode <= 86) return true;
  if (weatherCode >= 95 && weatherCode <= 99) return true;
  return false;
}

function supportsDirectSun(params: { cloudCoverPct?: number; weatherCode?: number; maxCloudCoverPct: number }) {
  const cloudOk = params.cloudCoverPct !== undefined && params.cloudCoverPct <= params.maxCloudCoverPct;
  const weatherOk = !blocksDirectSunFromWeatherCode(params.weatherCode);
  return cloudOk && weatherOk;
}

export function computeFrontSunnySamples(params: {
  pub: Pub;
  forecast: ForecastHour[];
  times: Date[];
  frontBearingDegOverride?: number;
  maxAngleFromFrontDeg?: number;
  maxCloudCoverPct?: number;
  minSunAltitudeDeg?: number;
  /**
   * Optional callback: return true if the sun ray is blocked by buildings.
   */
  isShadowedAtTime?: (t: Date, sun: { altitudeDeg: number; bearingDeg: number }) => boolean;
}) {
  const maxAngle = params.maxAngleFromFrontDeg ?? 80;
  const maxCloud = params.maxCloudCoverPct ?? 40;
  const minSunAltitudeDeg = params.minSunAltitudeDeg ?? 0;
  const frontBearing = params.frontBearingDegOverride ?? params.pub.frontBearingDeg;
  if (frontBearing === undefined) return [] as SunnyHour[];

  const out: SunnyHour[] = [];
  for (const t of params.times) {
    const pos = SunCalc.getPosition(t, params.pub.lat, params.pub.lon);
    const altitudeDeg = sunAltitudeDeg(pos);
    const bearingDeg = sunBearingFromNorthDeg(pos);
    const inFront = angleDiffDeg(bearingDeg, frontBearing) <= maxAngle;
    const hasSun = altitudeDeg > minSunAltitudeDeg;

    const snapshot = forecastSnapshotAtTime(params.forecast, t);
    const cloudCoverPct = snapshot.cloudCoverPct;
    const skyOk = supportsDirectSun({
      cloudCoverPct,
      weatherCode: snapshot.weatherCode,
      maxCloudCoverPct: maxCloud
    });

    const isShadowed = params.isShadowedAtTime ? params.isShadowedAtTime(t, { altitudeDeg, bearingDeg }) : undefined;
    const shadowOk = isShadowed === undefined ? true : !isShadowed;

    out.push({
      time: t,
      isFrontSunny: hasSun && inFront && skyOk && shadowOk,
      sunAltitudeDeg: altitudeDeg,
      sunBearingDeg: bearingDeg,
      cloudCoverPct,
      isShadowed
    });
  }
  return out;
}

export function computeGeneralSunnyHours(params: {
  pub: Pub;
  forecast: ForecastHour[];
  maxCloudCoverPct?: number;
  minSunAltitudeDeg?: number;
}) {
  const maxCloud = params.maxCloudCoverPct ?? 40;
  const minSunAltitudeDeg = params.minSunAltitudeDeg ?? 0;

  const hours: SunnyHour[] = [];
  for (const hour of params.forecast) {
    const pos = SunCalc.getPosition(hour.time, params.pub.lat, params.pub.lon);
    const altitude = sunAltitudeDeg(pos);
    const bearing = sunBearingFromNorthDeg(pos);
    const hasSun = altitude > minSunAltitudeDeg;
    const skyOk = supportsDirectSun({
      cloudCoverPct: hour.cloudCoverPct,
      weatherCode: hour.weatherCode,
      maxCloudCoverPct: maxCloud
    });

    hours.push({
      time: hour.time,
      isFrontSunny: hasSun && skyOk,
      sunAltitudeDeg: altitude,
      sunBearingDeg: bearing,
      cloudCoverPct: hour.cloudCoverPct
    });
  }
  return hours;
}

export function computeGeneralSunnySamples(params: {
  pub: Pub;
  forecast: ForecastHour[];
  times: Date[];
  maxCloudCoverPct?: number;
  minSunAltitudeDeg?: number;
}) {
  const maxCloud = params.maxCloudCoverPct ?? 40;
  const minSunAltitudeDeg = params.minSunAltitudeDeg ?? 0;

  const out: SunnyHour[] = [];
  for (const t of params.times) {
    const pos = SunCalc.getPosition(t, params.pub.lat, params.pub.lon);
    const altitudeDeg = sunAltitudeDeg(pos);
    const bearingDeg = sunBearingFromNorthDeg(pos);
    const hasSun = altitudeDeg > minSunAltitudeDeg;

    const snapshot = forecastSnapshotAtTime(params.forecast, t);
    const cloudCoverPct = snapshot.cloudCoverPct;
    const skyOk = supportsDirectSun({
      cloudCoverPct,
      weatherCode: snapshot.weatherCode,
      maxCloudCoverPct: maxCloud
    });

    out.push({
      time: t,
      isFrontSunny: hasSun && skyOk,
      sunAltitudeDeg: altitudeDeg,
      sunBearingDeg: bearingDeg,
      cloudCoverPct
    });
  }
  return out;
}

export function sunnyIntervalsFromHours(hours: SunnyHour[]) {
  const out: Interval[] = [];
  let start: Date | null = null;
  let prev: Date | null = null;
  const stepMs =
    hours.length >= 2
      ? Math.max(60_000, hours[1]!.time.getTime() - hours[0]!.time.getTime())
      : 10 * 60_000;

  for (const h of hours) {
    if (!h.isFrontSunny) {
      if (start && prev) out.push({ start, end: new Date(prev.getTime() + stepMs) });
      start = null;
      prev = null;
      continue;
    }

    if (!start) start = h.time;
    prev = h.time;
  }

  if (start && prev) out.push({ start, end: new Date(prev.getTime() + stepMs) });
  return out;
}
