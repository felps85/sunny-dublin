import type { LatLon } from "../types";

export async function requestUserLocation() {
  if (!("geolocation" in navigator)) throw new Error("Geolocation is not supported in this browser.");
  return await new Promise<LatLon>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(new Error(err.message)),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 }
    );
  });
}

