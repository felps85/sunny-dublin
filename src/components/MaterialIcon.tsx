import React from "react";

export type MaterialIconName =
  | "close"
  | "cloud"
  | "directions"
  | "help"
  | "info"
  | "light_mode"
  | "location_on"
  | "menu"
  | "my_location"
  | "refresh"
  | "search"
  | "sports_bar"
  | "sunny"
  | "wb_sunny";

const MATERIAL_ICON_PATHS: Record<MaterialIconName, string> = {
  close: "M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
  cloud:
    "M19.35 10.04C18.67 6.59 15.64 4 12 4c-2.63 0-4.88 1.57-5.9 3.83C3.24 8.15 1 10.62 1 13.5 1 16.54 3.46 19 6.5 19H19c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96",
  directions:
    "M21.71 11.29l-9-9a1 1 0 0 0-1.41 0l-9 9a1 1 0 0 0 0 1.41l9 9a1 1 0 0 0 1.41 0l9-9a1 1 0 0 0 0-1.41M13 18h-2v-4H8l4-4 4 4h-3z",
  help:
    "M11 18h2v-2h-2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2m0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8m0-14a4 4 0 0 0-4 4h2a2 2 0 1 1 4 0c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5a4 4 0 0 0-4-4",
  info:
    "M11 17h2v-6h-2zm1-8a1.25 1.25 0 1 0 0-2.5A1.25 1.25 0 0 0 12 9m0-7C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2m0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8",
  light_mode:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8m0-6h-1v3h1zm0 17h-1v3h1zm10-8h-3v1h3zM5 11H2v1h3zm13.36-5.95-.71-.71-2.12 2.12.71.71zM8.47 15.95l-.71-.71-2.12 2.12.71.71zm0-8.48L6.35 5.35 4.23 7.47l.71.71zm9.89 9.89-.71-.71-2.12 2.12.71.71z",
  location_on:
    "M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7m0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5.5",
  menu: "M3 18h18v-2H3zm0-5h18v-2H3zm0-7v2h18V6z",
  my_location:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8m8.94 3A9 9 0 0 0 13 3.06V1h-2v2.06A9 9 0 0 0 3.06 11H1v2h2.06A9 9 0 0 0 11 20.94V23h2v-2.06A9 9 0 0 0 20.94 13H23v-2zM12 19a7 7 0 1 1 0-14 7 7 0 0 1 0 14",
  refresh:
    "M17.65 6.35A7.95 7.95 0 0 0 12 4V1L7 6l5 5V7a5 5 0 1 1-4.9 6h-2.02A7 7 0 1 0 17.65 6.35",
  search:
    "M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79L20 21.5 21.5 20zM9.5 14A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14",
  sports_bar:
    "M19 9h-1.56c.33-.55.53-1.18.55-1.86c.04-1.03-.43-1.99-1.16-2.71c-1.54-1.54-2.74-1.56-3.82-1.29A4.615 4.615 0 0 0 10 2.02c-1.89 0-3.51 1.11-4.27 2.71C4.15 5.26 3 6.74 3 8.5c0 1.86 1.28 3.41 3 3.86V19c0 1.1.9 2 2 2h7c1.1 0 2-.9 2-2h2c1.1 0 2-.9 2-2v-6c0-1.1-.9-2-2-2zM7 10.5c-1.1 0-2-.9-2-2c0-.85.55-1.6 1.37-1.88l.8-.27l.36-.76C8 4.62 8.94 4.02 10 4.02c.79 0 1.39.35 1.74.65l.78.65S13.16 5 13.99 5c1.1 0 2 .9 2 2h-3C9.67 7 9.15 10.5 7 10.5zM19 17h-2v-6h2v6z",
  sunny:
    "M11 2h2v3h-2zm6.364 2.222 1.414 1.414-2.121 2.121-1.414-1.414zM19 11h3v2h-3zM7.757 6.343 5.636 4.222 4.222 5.636l2.121 2.121zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8m5.657 8.243 2.121 2.121-1.414 1.414-2.121-2.121zM11 19h2v3h-2zM6.343 16.243l1.414 1.414-2.121 2.121-1.414-1.414zM2 11h3v2H2z",
  wb_sunny:
    "M6.76 4.84 4.96 3.05 3.55 4.46l1.79 1.79zm10.48 12.7 1.79 1.79 1.41-1.41-1.79-1.79zM4 10.5H1v2h3zm19 0h-3v2h3zM11 1h2v3h-2zm0 19h2v3h-2zM5.34 17.55l-1.79 1.79 1.41 1.41 1.8-1.79zm14.11-13.09-1.41-1.41-1.79 1.79 1.41 1.41zM12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12m0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8"
};

type MaterialIconProps = {
  name: MaterialIconName;
  size?: number;
  className?: string;
  title?: string;
};

export function materialIconPath(name: MaterialIconName) {
  return MATERIAL_ICON_PATHS[name];
}

export function createMaterialIconSvg(params: {
  name: MaterialIconName;
  size: number;
  color?: string;
  className?: string;
}) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(params.size));
  svg.setAttribute("height", String(params.size));
  svg.setAttribute("aria-hidden", "true");
  if (params.className) svg.setAttribute("class", params.className);
  svg.style.display = "block";
  if (params.color) svg.style.color = params.color;

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", materialIconPath(params.name));
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}

export default function MaterialIcon({ name, size = 20, className, title }: MaterialIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : "presentation"}
      style={{ display: "block" }}
    >
      {title ? <title>{title}</title> : null}
      <path d={materialIconPath(name)} fill="currentColor" />
    </svg>
  );
}
