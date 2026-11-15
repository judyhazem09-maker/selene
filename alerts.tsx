import { AlertTriangle, ShieldCheck } from "lucide-react";
import type { LunarSimulationResponse } from "../types/scienceData";

type WarningLevel = "warning" | "critical";

type LocationWarning = {
  level: WarningLevel;
  title: string;
  detail: string;
};

type LocationWarningsProps = {
  isCustom: boolean;
  latitude: number;
  longitude: number;
  isArchiveSupported: boolean;
  simulation: LunarSimulationResponse | null;
  sunTerrainStatus: string | null;
  earthTerrainStatus: string | null;
};

function normalizeLongitude(longitude: number): number {
  return ((longitude % 360) + 360) % 360;
}

function simulationMatchesLocation(
  simulation: LunarSimulationResponse,
  latitude: number,
  longitude: number,
): boolean {
  return Math.abs(simulation.latitude_deg - latitude) < 1e-6
    && Math.abs(normalizeLongitude(simulation.longitude_deg) - normalizeLongitude(longitude)) < 1e-6;
}

export default function LocationWarnings({
  isCustom,
  latitude,
  longitude,
  isArchiveSupported,
  simulation,
  sunTerrainStatus,
  earthTerrainStatus,
}: LocationWarningsProps) {
  if (!isCustom) return null;

  const warnings: LocationWarning[] = [];
  const validCoordinates = Number.isFinite(latitude)
    && latitude >= -90
    && latitude <= 90
    && Number.isFinite(longitude)
    && longitude >= -360
    && longitude <= 360;

  if (!validCoordinates) {
    warnings.push({
      level: "critical",
      title: "Invalid coordinates",
      detail: "Enter a latitude from −90° to 90° and an east longitude from −360° to 360°.",
    });
  } else {
    if (latitude < -90 || latitude > -85) {
      warnings.push({
        level: "warning",
        title: "Outside the LOLA terrain coverage",
        detail: "The bundled elevation data cover 85°S through the south pole only.",
      });
    }

    if (!isArchiveSupported) {
      warnings.push({
        level: "critical",
        title: "This custom coordinate is not in the verified archive",
        detail: "JPL ephemerides and LOLA terrain are available only for the three named sites. Sunlight, Earth visibility, and terrain safety cannot be assessed here.",
      });
    } else {
      const currentSimulation = simulation && simulationMatchesLocation(simulation, latitude, longitude)
        ? simulation
        : null;

      if (!currentSimulation) {
        warnings.push({
          level: "warning",
          title: "Run an archived analysis to screen this location",
          detail: "The checks below use the selected analysis window and the current Sun/Earth terrain rays.",
        });
      } else {
        const sunlightPercent = currentSimulation.geometric_sunlight_hours
          / currentSimulation.duration_hours * 100;
        const earthVisibilityPercent = currentSimulation.earth_visible_hours
          / currentSimulation.duration_hours * 100;

        if (sunlightPercent < 50) {
          warnings.push({
            level: "warning",
            title: "Limited geometric sunlight",
            detail: `${sunlightPercent.toFixed(0)}% of this window is geometrically sunlit; the screening threshold is 50%.`,
          });
        }

        if (earthVisibilityPercent < 25) {
          warnings.push({
            level: "warning",
            title: "Limited geometric Earth visibility",
            detail: `${earthVisibilityPercent.toFixed(0)}% of this window has geometric Earth visibility; the screening threshold is 25%. This is not a communications link assessment.`,
          });
        }

        if (currentSimulation.unmet_load_wh > 0) {
          warnings.push({
            level: "critical",
            title: "The modeled power system cannot meet the mission load",
            detail: `${currentSimulation.unmet_load_wh.toFixed(0)} Wh of load is unmet in this analysis window.`,
          });
        } else if (currentSimulation.minimum_battery_percent < 20) {
          warnings.push({
            level: "warning",
            title: "Low modeled battery reserve",
            detail: `Battery charge falls to ${currentSimulation.minimum_battery_percent.toFixed(0)}%; the screening reserve is 20%.`,
          });
        }

        if (sunTerrainStatus === "intercepted by local terrain") {
          warnings.push({
            level: "critical",
            title: "Local terrain intercepts the current Sun ray",
            detail: "The sampled LOLA profile indicates terrain blockage at the currently selected time.",
          });
        }

        if (earthTerrainStatus === "intercepted by local terrain") {
          warnings.push({
            level: "warning",
            title: "Local terrain intercepts the current Earth ray",
            detail: "The sampled LOLA profile indicates blockage at the currently selected time; this does not establish a communications link.",
          });
        }

        if (warnings.length === 0) {
          warnings.push({
            level: "warning",
            title: "No screening threshold was crossed for this window",
            detail: "This preliminary check is not a landing-safety certification and does not model all mission risks.",
          });
        }
      }
    }
  }

  const hasCriticalWarning = warnings.some((warning) => warning.level === "critical");

  return (
    <section
      className={`location-warnings ${hasCriticalWarning ? "has-critical" : "has-warning"}`}
      aria-label="Custom location screening"
      aria-live="polite"
    >
      <div className="location-warnings-heading">
        {hasCriticalWarning ? <AlertTriangle size={15} /> : <ShieldCheck size={15} />}
        <div>
          <strong>{hasCriticalWarning ? "LOCATION WARNING" : "LOCATION SCREENING"}</strong>
          <span>Preliminary checks · not a landing-safety decision</span>
        </div>
      </div>
      <ul>
        {warnings.map((warning) => (
          <li className={`location-warning-item ${warning.level}`} key={`${warning.title}-${warning.detail}`}>
            <strong>{warning.title}</strong>
            <span>{warning.detail}</span>
          </li>
        ))}
      </ul>
      <p className="location-warning-thresholds">
        Screening thresholds: sunlight &lt;50%, Earth visibility &lt;25%, battery reserve &lt;20%, or a terrain-blocked current ray.
      </p>
    </section>
  );
}
