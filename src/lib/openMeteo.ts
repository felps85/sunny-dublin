import type { ForecastHour } from "../types";

type OpenMeteoResponse = {
  hourly?: {
    time?: string[];
    cloud_cover?: number[];
    weather_code?: number[];
  };
};

export async function fetchForecastHourly(params: { lat: number; lon: number; hours: number }) {
  const { lat, lon, hours } = params;
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("hourly", "cloud_cover,weather_code");
  url.searchParams.set("forecast_hours", String(hours));
  url.searchParams.set("timezone", "Europe/Dublin");

  const res = await fetch(url.toString(), { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Open-Meteo error: ${res.status} ${res.statusText}`);
  const json = (await res.json()) as OpenMeteoResponse;

  const times = json.hourly?.time ?? [];
  const cloud = json.hourly?.cloud_cover ?? [];
  const code = json.hourly?.weather_code ?? [];

  const out: ForecastHour[] = [];
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (!t) continue;
    const time = new Date(t);
    out.push({
      time,
      cloudCoverPct: cloud[i],
      weatherCode: code[i]
    });
  }
  return out;
}

