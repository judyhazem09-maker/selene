import type {
  LunarSimulationResponse,
  MissionSimulationRequest,
  NasaImageSearchResponse,
  TerrainProfileResponse,
} from "../types/scienceData";

type EphemerisArchive = {
  file: string;
  rows: number;
  format: string;
  sha256: string;
  source: string;
  ephemeris: string;
};

type TerrainArchive = {
  file: string;
  width: number;
  height: number;
  firstRow: number;
  firstColumn: number;
  format: string;
  source: string;
  product: string;
  sourceUrl: string;
  imageUrl: string;
  resolutionM: number;
  referenceRadiusM: number;
  tileMarginM: number;
  sha256: string;
};

type ArchiveSite = {
  id: string;
  name: string;
  latitudeDeg: number;
  longitudeEastDeg: number;
  ephemeris: EphemerisArchive;
  terrain: TerrainArchive;
};

type ScienceArchiveManifest = {
  generatedAtUtc: string;
  archiveStartUtc: string;
  latestSupportedStartUtc: string;
  ephemerisEndUtc: string;
  sampleIntervalMinutes: number;
  dataStatus: string;
  sourceDescription: string;
  imageSide: number;
  recordBytes: number;
  imageBytes: number;
  sites: ArchiveSite[];
};

type Observation = {
  time: number;
  sunAzimuth: number;
  sunElevation: number;
  earthAzimuth: number;
  earthElevation: number;
};

const archiveBase = () => new URL(import.meta.env.BASE_URL, window.location.href);
const archiveUrl = (file: string) => new URL(`science/${file}`, archiveBase()).href;
const hourlyMs = 60 * 60 * 1000;
const irradianceAtOneAu = 1361;
const batteryEfficiency = 0.9;
const profileSampleCount = 251;
const fileCache = new Map<string, Promise<ArrayBuffer>>();
let manifestCache: Promise<ScienceArchiveManifest> | undefined;
let archiveVerificationCache: Promise<void> | undefined;

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function roundTo(value: number, decimalPlaces: number): number {
  const scale = 10 ** decimalPlaces;
  const scaled = value * scale;
  const lower = Math.floor(scaled);
  const fraction = scaled - lower;
  if (Math.abs(fraction - 0.5) < Number.EPSILON * Math.max(1, Math.abs(scaled)) * 2) {
    return (lower % 2 === 0 ? lower : lower + 1) / scale;
  }
  return Math.round(scaled) / scale;
}

function normalizeLongitude(longitudeDeg: number): number {
  return ((longitudeDeg % 360) + 360) % 360;
}

function getManifest(): Promise<ScienceArchiveManifest> {
  if (!manifestCache) {
    manifestCache = fetch(archiveUrl("manifest.json"))
      .then(async (response) => {
        if (!response.ok) throw new Error(`Local science archive manifest returned HTTP ${response.status}.`);
        const manifest = await response.json() as ScienceArchiveManifest;
        assert(manifest.dataStatus === "verified-archived", "The local science archive has an unsupported status.");
        assert(manifest.sampleIntervalMinutes === 60, "The local science archive has an unsupported sampling interval.");
        assert(manifest.sites.length === 3, "The local science archive does not contain all three candidate sites.");
        return manifest;
      })
      .catch((error: unknown) => {
        manifestCache = undefined;
        throw error;
      });
  }
  return manifestCache;
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("This browser cannot verify the local science archive. Open LunaSight over HTTPS.");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function loadArchiveFile(file: string, expectedHash: string): Promise<ArrayBuffer> {
  let pending = fileCache.get(file);
  if (!pending) {
    pending = fetch(archiveUrl(file))
      .then(async (response) => {
        if (!response.ok) throw new Error(`Local science data '${file}' returned HTTP ${response.status}.`);
        const buffer = await response.arrayBuffer();
        const actualHash = await sha256Hex(buffer);
        if (actualHash !== expectedHash) {
          throw new Error(`Local science data '${file}' failed its SHA-256 integrity check.`);
        }
        return buffer;
      })
      .catch((error: unknown) => {
        fileCache.delete(file);
        throw error;
      });
    fileCache.set(file, pending);
  }
  return pending;
}

export function verifyScienceArchive(): Promise<void> {
  if (!archiveVerificationCache) {
    archiveVerificationCache = (async () => {
      const manifest = await getManifest();
      const files = manifest.sites.flatMap((site) => [site.ephemeris.file, site.terrain.file]);
      await Promise.all(files.map(async (file) => {
        const response = await fetch(archiveUrl(file), { method: "HEAD" });
        if (!response.ok) throw new Error(`Local science data '${file}' returned HTTP ${response.status}.`);
      }));
    })().catch((error: unknown) => {
      archiveVerificationCache = undefined;
      throw error;
    });
  }
  return archiveVerificationCache;
}

function findArchivedSite(latitudeDeg: number, longitudeDeg: number, manifest: ScienceArchiveManifest): ArchiveSite {
  const longitudeEastDeg = normalizeLongitude(longitudeDeg);
  const site = manifest.sites.find((candidate) => (
    Math.abs(candidate.latitudeDeg - latitudeDeg) < 1e-6
    && Math.abs(candidate.longitudeEastDeg - longitudeEastDeg) < 1e-6
  ));
  if (!site) {
    const supportedSites = manifest.sites.map((candidate) => candidate.name).join(", ");
    throw new Error(
      `No verified JPL or LOLA archive exists for these coordinates. Archived locations: ${supportedSites}. Select a named landing site; no measurements are estimated.`,
    );
  }
  return site;
}

function validateRequest(request: MissionSimulationRequest, manifest: ScienceArchiveManifest): {
  site: ArchiveSite;
  startTimeMs: number;
  durationHours: number;
} {
  const numericInputs = [
    request.latitude_deg,
    request.longitude_deg,
    request.duration_hours,
    request.panel_area_m2,
    request.panel_efficiency,
    request.panel_tilt_deg,
    request.panel_azimuth_deg,
    request.system_losses_percent,
    request.battery_capacity_kwh,
    request.load_w,
    request.initial_battery_percent,
  ];
  assert(numericInputs.every(Number.isFinite), "All mission inputs must be finite numbers.");
  assert(Number.isFinite(request.latitude_deg) && request.latitude_deg >= -90 && request.latitude_deg <= 90, "Latitude must be between −90° and 90°.");
  assert(Number.isFinite(request.longitude_deg) && request.longitude_deg >= -360 && request.longitude_deg <= 360, "East longitude must be between −360° and 360°.");
  assert(Number.isInteger(request.duration_hours) && request.duration_hours >= 6 && request.duration_hours <= 48, "Simulation duration must be from 6 to 48 hours.");
  assert(request.panel_area_m2 > 0 && request.panel_area_m2 <= 1000, "Panel area must be greater than 0 and no more than 1,000 m².");
  assert(request.panel_efficiency > 0 && request.panel_efficiency <= 1, "Panel efficiency must be greater than 0% and no more than 100%.");
  assert(request.panel_tilt_deg >= 0 && request.panel_tilt_deg <= 90, "Panel tilt must be between 0° and 90°.");
  assert(request.panel_azimuth_deg >= 0 && request.panel_azimuth_deg <= 360, "Panel azimuth must be between 0° and 360°.");
  assert(request.system_losses_percent >= 0 && request.system_losses_percent < 100, "System losses must be from 0% to less than 100%.");
  assert(request.battery_capacity_kwh > 0 && request.battery_capacity_kwh <= 10_000, "Battery capacity must be greater than 0 and no more than 10,000 kWh.");
  assert(request.load_w >= 0 && request.load_w <= 1_000_000, "Mission load must be from 0 to 1,000,000 W.");
  assert(request.initial_battery_percent >= 0 && request.initial_battery_percent <= 100, "Initial battery charge must be from 0% to 100%.");

  const startTimeMs = Date.parse(request.start_time_utc);
  assert(Number.isFinite(startTimeMs), "Choose a valid analysis start time.");
  const startTime = new Date(startTimeMs);
  assert(
    startTime.getUTCMinutes() === 0 && startTime.getUTCSeconds() === 0 && startTime.getUTCMilliseconds() === 0,
    "Verified JPL archive samples are hourly. Choose a UTC start time on the hour.",
  );
  const archiveStartMs = Date.parse(manifest.archiveStartUtc);
  const latestStartMs = Date.parse(manifest.latestSupportedStartUtc);
  const endTimeMs = startTimeMs + request.duration_hours * hourlyMs;
  const archiveEndMs = Date.parse(manifest.ephemerisEndUtc);
  assert(
    startTimeMs >= archiveStartMs && startTimeMs <= latestStartMs && endTimeMs <= archiveEndMs,
    `Verified JPL Horizons data are archived for whole-hour UTC starts from ${manifest.archiveStartUtc.slice(0, 10)} through ${manifest.latestSupportedStartUtc.slice(0, 10)} at the three named sites.`,
  );

  return {
    site: findArchivedSite(request.latitude_deg, request.longitude_deg, manifest),
    startTimeMs,
    durationHours: request.duration_hours,
  };
}

function estimatePanelPower(
  observation: Observation,
  request: MissionSimulationRequest,
): number {
  if (observation.sunElevation <= 0) return 0;
  const elevation = observation.sunElevation * Math.PI / 180;
  const tilt = request.panel_tilt_deg * Math.PI / 180;
  const azimuthDifference = (observation.sunAzimuth - request.panel_azimuth_deg) * Math.PI / 180;
  const incidenceFactor = Math.max(0, Math.min(1,
    Math.sin(elevation) * Math.cos(tilt)
      + Math.cos(elevation) * Math.sin(tilt) * Math.cos(azimuthDifference),
  ));
  return irradianceAtOneAu
    * request.panel_area_m2
    * request.panel_efficiency
    * (1 - request.system_losses_percent / 100)
    * incidenceFactor;
}

function thresholdWindows(observations: Array<{ time: number; elevation: number }>) {
  if (observations.length < 2) return [];
  const windows: Array<{ start_utc: string; end_utc: string; duration_hours: number }> = [];
  let windowStart: number | null = observations[0].elevation > 0 ? observations[0].time : null;
  for (let index = 0; index < observations.length - 1; index += 1) {
    const start = observations[index];
    const end = observations[index + 1];
    if (start.elevation <= 0 && end.elevation > 0) {
      const fraction = -start.elevation / (end.elevation - start.elevation);
      windowStart = start.time + (end.time - start.time) * fraction;
    } else if (start.elevation > 0 && end.elevation <= 0) {
      const fraction = start.elevation / (start.elevation - end.elevation);
      const windowEnd = start.time + (end.time - start.time) * fraction;
      if (windowStart !== null && windowEnd > windowStart) {
        windows.push({
          start_utc: new Date(windowStart).toISOString(),
          end_utc: new Date(windowEnd).toISOString(),
          duration_hours: (windowEnd - windowStart) / hourlyMs,
        });
      }
      windowStart = null;
    }
  }
  const last = observations[observations.length - 1];
  if (windowStart !== null && last.time > windowStart) {
    windows.push({
      start_utc: new Date(windowStart).toISOString(),
      end_utc: new Date(last.time).toISOString(),
      duration_hours: (last.time - windowStart) / hourlyMs,
    });
  }
  return windows;
}

function positiveElevationHours(observations: Array<{ time: number; elevation: number }>): number {
  let illuminatedHours = 0;
  for (let index = 0; index < observations.length - 1; index += 1) {
    const start = observations[index];
    const end = observations[index + 1];
    const intervalHours = (end.time - start.time) / hourlyMs;
    if (start.elevation > 0 && end.elevation > 0) illuminatedHours += intervalHours;
    else if (start.elevation <= 0 && end.elevation > 0) {
      illuminatedHours += intervalHours * end.elevation / (end.elevation - start.elevation);
    } else if (start.elevation > 0 && end.elevation <= 0) {
      illuminatedHours += intervalHours * start.elevation / (start.elevation - end.elevation);
    }
  }
  return illuminatedHours;
}

export async function runMissionSimulation(
  request: MissionSimulationRequest,
): Promise<LunarSimulationResponse> {
  const manifest = await getManifest();
  const { site, startTimeMs, durationHours } = validateRequest(request, manifest);
  const buffer = await loadArchiveFile(site.ephemeris.file, site.ephemeris.sha256);
  const startIndex = (startTimeMs - Date.parse(manifest.archiveStartUtc)) / hourlyMs;
  const rowCount = durationHours + 1;
  assert(buffer.byteLength === site.ephemeris.rows * 16, `The archived JPL ephemeris for ${site.name} has an invalid size.`);
  assert(startIndex + rowCount <= site.ephemeris.rows, "This simulation window exceeds the archived JPL data.");

  const view = new DataView(buffer);
  const observations: Observation[] = Array.from({ length: rowCount }, (_, index) => {
    const rowIndex = startIndex + index;
    const offset = rowIndex * 16;
    return {
      time: startTimeMs + index * hourlyMs,
      sunAzimuth: view.getInt32(offset, true) / 1_000_000,
      sunElevation: view.getInt32(offset + 4, true) / 1_000_000,
      earthAzimuth: view.getInt32(offset + 8, true) / 1_000_000,
      earthElevation: view.getInt32(offset + 12, true) / 1_000_000,
    };
  });
  const panelPower = observations.map((observation) => estimatePanelPower(observation, request));
  const capacityWh = request.battery_capacity_kwh * 1000;
  let storedEnergyWh = capacityWh * request.initial_battery_percent / 100;
  let minimumEnergyWh = storedEnergyWh;
  let unmetLoadWh = 0;
  let totalSolarEnergyWh = 0;
  const batteryLevels = [request.initial_battery_percent];
  const totalLoadWh = request.load_w * durationHours;

  for (let index = 0; index < observations.length - 1; index += 1) {
    const intervalHours = (observations[index + 1].time - observations[index].time) / hourlyMs;
    assert(intervalHours > 0, "The archived JPL ephemeris contains unordered rows.");
    const intervalSolarWh = (panelPower[index] + panelPower[index + 1]) * 0.5 * intervalHours;
    totalSolarEnergyWh += intervalSolarWh;
    const netEnergyWh = intervalSolarWh - request.load_w * intervalHours;
    if (netEnergyWh >= 0) {
      storedEnergyWh = Math.min(capacityWh, storedEnergyWh + netEnergyWh * batteryEfficiency);
    } else {
      const requiredBatteryWh = -netEnergyWh / batteryEfficiency;
      const suppliedBatteryWh = Math.min(storedEnergyWh, requiredBatteryWh);
      storedEnergyWh -= suppliedBatteryWh;
      unmetLoadWh += (-netEnergyWh) - suppliedBatteryWh * batteryEfficiency;
    }
    minimumEnergyWh = Math.min(minimumEnergyWh, storedEnergyWh);
    batteryLevels.push(100 * storedEnergyWh / capacityWh);
  }

  const sunAltitudes = observations.map(({ time, sunElevation }) => ({ time, elevation: sunElevation }));
  const earthAltitudes = observations.map(({ time, earthElevation }) => ({ time, elevation: earthElevation }));
  const sunlightHours = positiveElevationHours(sunAltitudes);
  const communicationWindows = thresholdWindows(earthAltitudes);
  const earthVisibleHours = communicationWindows.reduce((sum, window) => sum + window.duration_hours, 0);
  const samples = observations.map((observation, index) => ({
    time_utc: new Date(observation.time).toISOString(),
    sun_azimuth_deg: roundTo(observation.sunAzimuth, 4),
    sun_elevation_deg: roundTo(observation.sunElevation, 4),
    sunlight: observation.sunElevation > 0,
    earth_azimuth_deg: roundTo(observation.earthAzimuth, 4),
    earth_elevation_deg: roundTo(observation.earthElevation, 4),
    earth_visible: observation.earthElevation > 0,
    panel_power_w: roundTo(panelPower[index], 2),
    battery_percent: roundTo(batteryLevels[index], 2),
  }));

  return {
    source: "NASA/JPL Horizons (DE441 archived locally)",
    source_detail: `Verified NASA/JPL Horizons DE441 observer ephemerides archived for ${site.name}; retrieved ${manifest.generatedAtUtc}.`,
    retrieved_at_utc: manifest.generatedAtUtc,
    latitude_deg: site.latitudeDeg,
    longitude_deg: site.longitudeEastDeg,
    start_time_utc: new Date(startTimeMs).toISOString(),
    end_time_utc: new Date(observations[observations.length - 1].time).toISOString(),
    duration_hours: durationHours,
    sample_interval_minutes: manifest.sampleIntervalMinutes,
    geometric_sunlight_hours: roundTo(sunlightHours, 2),
    geometric_shadow_hours: roundTo(Math.max(0, durationHours - sunlightHours), 2),
    earth_visible_hours: roundTo(earthVisibleHours, 2),
    communication_windows: communicationWindows,
    reference_irradiance_w_m2: irradianceAtOneAu,
    panel_peak_reference_w: roundTo(
      irradianceAtOneAu
        * request.panel_area_m2
        * request.panel_efficiency
        * (1 - request.system_losses_percent / 100),
      2,
    ),
    predicted_panel_energy_wh: roundTo(totalSolarEnergyWh, 2),
    mission_load_w: request.load_w,
    mission_energy_demand_wh: roundTo(totalLoadWh, 2),
    battery_capacity_kwh: request.battery_capacity_kwh,
    ending_battery_percent: roundTo(100 * storedEnergyWh / capacityWh, 2),
    minimum_battery_percent: roundTo(100 * minimumEnergyWh / capacityWh, 2),
    unmet_load_wh: roundTo(unmetLoadWh, 2),
    terrain_occlusion_included: false,
    communication_link_budget_included: false,
    limitations: [
      `Sun and Earth positions are original JPL Horizons ${site.ephemeris.ephemeris} hourly observer samples for ${site.name}, not live queries.`,
      `The verified archive covers only the three named candidate sites and hourly UTC starts from ${manifest.archiveStartUtc.slice(0, 10)} through ${manifest.latestSupportedStartUtc.slice(0, 10)}.`,
      "Local horizon visibility uses Horizons geometric body-site observer geometry; nearby crater walls and terrain occlusion are not included in mission totals.",
      "Solar panel output uses 1361 W/m² at 1 AU, panel incidence, user efficiency, and user system losses; actual Sun-Moon distance and panel temperature or degradation are not modeled.",
      "Battery state of charge uses a fixed 90% charge/discharge efficiency and constant user-entered load; thermal limits and detailed battery behavior are not modeled.",
      "Ephemerides are sampled hourly, so short visibility events may be missed and event times are linearly interpolated between hourly source samples.",
      "Earth geometric visibility is not a communication link; antenna pointing, link budget, relay availability, and terrain blockage require separate analysis.",
    ],
    samples,
  };
}

function destinationPoint(
  latitudeDeg: number,
  longitudeDeg: number,
  bearingDeg: number,
  distanceKm: number,
): [number, number] {
  const angularDistance = distanceKm * 1000 / 1_737_400;
  const latitude = latitudeDeg * Math.PI / 180;
  const longitude = longitudeDeg * Math.PI / 180;
  const bearing = bearingDeg * Math.PI / 180;
  const targetLatitude = Math.asin(
    Math.sin(latitude) * Math.cos(angularDistance)
      + Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const targetLongitude = longitude + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
    Math.cos(angularDistance) - Math.sin(latitude) * Math.sin(targetLatitude),
  );
  return [
    targetLatitude * 180 / Math.PI,
    (targetLongitude * 180 / Math.PI + 360) % 360,
  ];
}

function pythonRound(value: number): number {
  const lower = Math.floor(value);
  const fraction = value - lower;
  if (Math.abs(fraction - 0.5) < 1e-10) return lower % 2 === 0 ? lower : lower + 1;
  return Math.round(value);
}

function projectToPixel(latitudeDeg: number, longitudeDeg: number, imageSide: number): { row: number; column: number } {
  const colatitude = (90 + latitudeDeg) * Math.PI / 180;
  const longitude = longitudeDeg * Math.PI / 180;
  const radiusM = 2 * 1_737_400 * Math.tan(colatitude / 2);
  const imageCenter = (imageSide - 1) / 2;
  return {
    column: pythonRound(imageCenter + radiusM * Math.sin(longitude) / 40),
    row: pythonRound(imageCenter - radiusM * Math.cos(longitude) / 40),
  };
}

export async function fetchTerrainProfile(
  latitudeDeg: number,
  longitudeDeg: number,
  bearingDeg: number,
  signal?: AbortSignal,
): Promise<TerrainProfileResponse> {
  const manifest = await getManifest();
  const site = findArchivedSite(latitudeDeg, longitudeDeg, manifest);
  const terrain = site.terrain;
  const buffer = await loadArchiveFile(terrain.file, terrain.sha256);
  if (signal?.aborted) throw new DOMException("Terrain request cancelled.", "AbortError");
  assert(terrain.format === "float32-le-kilometers", `The local LOLA tile format is unsupported for ${site.name}.`);
  assert(buffer.byteLength === terrain.width * terrain.height * 4, `The local LOLA tile for ${site.name} has an invalid size.`);

  const coordinates = Array.from({ length: profileSampleCount }, (_, index) => {
    const distanceKm = 10 * index / (profileSampleCount - 1);
    const [latitude, longitude] = destinationPoint(
      latitudeDeg,
      longitudeDeg,
      ((bearingDeg % 360) + 360) % 360,
      distanceKm,
    );
    assert(
      latitude <= -85,
      "The requested 10 km terrain ray extends outside the LOLA DEM coverage (85°S through the south pole).",
    );
    const pixel = projectToPixel(latitude, longitude, manifest.imageSide);
    const localRow = pixel.row - terrain.firstRow;
    const localColumn = pixel.column - terrain.firstColumn;
    assert(
      localRow >= 0 && localRow < terrain.height && localColumn >= 0 && localColumn < terrain.width,
      `This ray is outside the locally archived LOLA tile for ${site.name}; no elevation is estimated.`,
    );
    return { distanceKm, latitude, longitude, localRow, localColumn };
  });

  const view = new DataView(buffer);
  const samples = coordinates.map((coordinate) => {
    const byteOffset = (coordinate.localRow * terrain.width + coordinate.localColumn) * 4;
    const elevationKm = view.getFloat32(byteOffset, true);
    assert(Number.isFinite(elevationKm), "The original LOLA DEM contains a missing elevation sample along this ray.");
    return {
      distance_km: roundTo(coordinate.distanceKm, 3),
      latitude_deg: roundTo(coordinate.latitude, 6),
      longitude_deg: roundTo(coordinate.longitude, 6),
      relative_elevation_m: roundTo(elevationKm * 1000, 2),
    };
  });
  const siteElevationM = samples[0].relative_elevation_m;
  const terrainHorizonElevationDeg = Math.max(
    ...samples.slice(1).map((sample) => {
      const angularDistance = sample.distance_km * 1000 / terrain.referenceRadiusM;
      return Math.atan2(
        (terrain.referenceRadiusM + sample.relative_elevation_m) * Math.cos(angularDistance)
          - (terrain.referenceRadiusM + siteElevationM),
        (terrain.referenceRadiusM + sample.relative_elevation_m) * Math.sin(angularDistance),
      ) * 180 / Math.PI;
    }),
  );

  return {
    source: terrain.source,
    product: terrain.product,
    source_url: terrain.sourceUrl,
    resolution_m: terrain.resolutionM,
    reference_radius_m: terrain.referenceRadiusM,
    bearing_from_north_deg: ((bearingDeg % 360) + 360) % 360,
    distance_km: 10,
    site_elevation_m: siteElevationM,
    terrain_horizon_elevation_deg: roundTo(terrainHorizonElevationDeg, 3),
    samples,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNasaSearch(payload: unknown, query: string): NasaImageSearchResponse {
  const collection = isRecord(payload) && isRecord(payload.collection) ? payload.collection : {};
  const metadata = isRecord(collection.metadata) ? collection.metadata : {};
  const rawItems = Array.isArray(collection.items) ? collection.items : [];
  const items = rawItems.flatMap((rawItem) => {
    if (!isRecord(rawItem) || !Array.isArray(rawItem.data) || !isRecord(rawItem.data[0])) return [];
    const record = rawItem.data[0];
    if (typeof record.nasa_id !== "string" || typeof record.title !== "string") return [];
    const links = Array.isArray(rawItem.links) ? rawItem.links : [];
    const validLinks = links.flatMap((rawLink) => {
      if (!isRecord(rawLink) || typeof rawLink.href !== "string") return [];
      try {
        const url = new URL(rawLink.href);
        return url.protocol === "https:" && url.hostname === "images-assets.nasa.gov"
          ? [{ href: url.href, preview: rawLink.rel === "preview" }]
          : [];
      } catch {
        return [];
      }
    });
    const thumbnailUrl = validLinks.find((link) => link.preview)?.href ?? validLinks[0]?.href ?? null;
    const rawDescription = typeof record.description_508 === "string" && record.description_508
      ? record.description_508
      : typeof record.description === "string" ? record.description : "";
    const description = rawDescription
      .replace(/<[^>]*>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1200);
    const credit = typeof record.secondary_creator === "string"
      ? record.secondary_creator
      : typeof record.photographer === "string"
        ? record.photographer
        : typeof record.center === "string" ? record.center : "NASA";

    return [{
      nasa_id: record.nasa_id,
      title: record.title,
      description,
      credit,
      date_created: typeof record.date_created === "string" ? record.date_created : null,
      thumbnail_url: thumbnailUrl,
      source_url: `https://images.nasa.gov/details/${encodeURIComponent(record.nasa_id)}`,
    }];
  });
  const totalResults = typeof metadata.total_hits === "number" && Number.isInteger(metadata.total_hits)
    ? metadata.total_hits
    : items.length;
  return { source: "NASA Image and Video Library", query, total_results: totalResults, items };
}

export async function fetchNasaImages(
  query: string,
  signal?: AbortSignal,
): Promise<NasaImageSearchResponse> {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length < 2 || normalizedQuery.length > 120) {
    throw new Error("NASA image search terms must contain 2–120 characters.");
  }
  const params = new URLSearchParams({ q: normalizedQuery, media_type: "image", page_size: "6" });
  const response = await fetch(`https://images-api.nasa.gov/search?${params}`, { signal });
  if (!response.ok) {
    throw new Error(`NASA Images API returned HTTP ${response.status}.`);
  }
  return normalizeNasaSearch(await response.json(), normalizedQuery);
}
