export type Pub = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  displayLat?: number;
  displayLon?: number;
  /**
   * Bearing (degrees) the pub front faces, where:
   * - 0 = North
   * - 90 = East
   * - 180 = South
   * - 270 = West
   *
   * If unknown, the UI will treat as "needs calibration".
   */
  frontBearingDeg?: number;
  /**
   * Minimum sun altitude, in degrees, needed before nearby buildings are
   * unlikely to keep this facade/street in shade.
   */
  shadeClearanceDeg?: number;
};

export type ForecastHour = {
  time: Date;
  cloudCoverPct?: number;
  weatherCode?: number;
};

export type SunnyHour = {
  time: Date;
  isFrontSunny: boolean;
  sunAltitudeDeg: number;
  sunBearingDeg: number;
  cloudCoverPct?: number;
  isShadowed?: boolean;
};

export type Interval = {
  start: Date;
  end: Date;
};

export type LatLon = { lat: number; lon: number };

export type MapViewport = {
  center: LatLon;
  north: number;
  south: number;
  east: number;
  west: number;
  zoom: number;
};

export type EntrancePoint = {
  location: LatLon;
  kind: "main" | "secondary";
};

export type BuildingFootprint = {
  polygon: LatLon[];
  heightM: number;
  minHeightM: number;
  heightSource: "height" | "levels" | "assumed";
  entrances: EntrancePoint[];
};

export type RoadSegment = {
  points: LatLon[];
  highway?: string;
};

export type NearbyMapContext = {
  buildings: BuildingFootprint[];
  roads: RoadSegment[];
};

export type FacadeInference = {
  bearingDeg: number;
  edge: [LatLon, LatLon];
  entrance?: EntrancePoint;
  roadSegment?: [LatLon, LatLon];
};
