import type { LatLon } from "../types";

function getGeolocationErrorMessage(err: GeolocationPositionError) {
  const rawMessage = err.message || "";

  if (!window.isSecureContext || /origin does not have permission to use geolocation service/i.test(rawMessage)) {
    return "Location needs a secure HTTPS site and browser permission. If the custom domain is failing on mobile, try https://felps85.github.io/sunny-dublin/ instead.";
  }

  switch (err.code) {
    case err.PERMISSION_DENIED:
      return "Location permission was denied. Please allow location access for this site in your browser settings.";
    case err.POSITION_UNAVAILABLE:
      return "Your location is unavailable right now. Please try again in a moment.";
    case err.TIMEOUT:
      return "Location took too long to load. Please try again.";
    default:
      return rawMessage || "Couldn’t get your location right now.";
  }
}

export async function requestUserLocation() {
  if (!("geolocation" in navigator)) throw new Error("Geolocation is not supported in this browser.");
  if (!window.isSecureContext) {
    throw new Error(
      "Location needs a secure HTTPS site. If the custom domain is failing on mobile, try https://felps85.github.io/sunny-dublin/ instead."
    );
  }
  return await new Promise<LatLon>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(new Error(getGeolocationErrorMessage(err))),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 }
    );
  });
}
