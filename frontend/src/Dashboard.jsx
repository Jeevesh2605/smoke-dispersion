
import { useEffect, useMemo, useState } from "react";
import "./Dashboard.css";

const API_URL = "http://127.0.0.1:8000";
const CSV_URL = "/data/aqi_recent.csv";

const RISK = {
  Low: { color: "#36c995", title: "Low risk", action: "Continue your usual routine." },
  Moderate: {
    color: "#f2c653",
    title: "Moderate risk",
    action: "Take sensible precautions outdoors.",
  },
  High: {
    color: "#ff8a4c",
    title: "High risk",
    action: "Reduce prolonged or strenuous outdoor activity.",
  },
  "Very High": {
    color: "#ff4d78",
    title: "Very high risk",
    action: "Avoid unnecessary outdoor exertion and check official local guidance.",
  },
};

function getRisk(risk) {
  return RISK[risk] || {
    color: "#9aa7b5",
    title: risk || "Risk unavailable",
    action: "Check local air-quality guidance before making outdoor activity decisions.",
  };
}

// Handles quoted station names that contain commas.
function parseCSVLine(line) {
  const fields = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"' && quoted && line[i + 1] === '"') {
      field += '"';
      i++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      fields.push(field.trim());
      field = "";
    } else {
      field += char;
    }
  }

  fields.push(field.trim());
  return fields;
}

async function fetchStations() {
  const response = await fetch(CSV_URL);
  if (!response.ok) throw new Error("Could not load monitoring locations.");

  const text = await response.text();
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error("The station dataset is empty.");

  const headers = parseCSVLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const values = parseCSVLine(line);
    return Object.fromEntries(headers.map((header, i) => [header, values[i]]));
  });

  // Keep the latest available observation for each station ID.
  const latestById = new Map();

  for (const row of rows) {
    if (!row.location_id || !row.location_name) continue;

    const previous = latestById.get(String(row.location_id));
    if (!previous || String(row.date) > String(previous.date)) {
      latestById.set(String(row.location_id), row);
    }
  }

  return [...latestById.values()]
    .map((row) => ({
      id: Number(row.location_id),
      name: row.location_name,
      date: row.date,
    }))
    .filter((station) => Number.isFinite(station.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function MetricCard({ label, value, unit, detail, accent }) {
  return (
    <article className="metric-card">
      <div className="metric-card-top">
        <span>{label}</span>
        <span className="metric-accent" style={{ background: accent }} />
      </div>
      <div className="metric-value">
        {value}
        {unit && <small>{unit}</small>}
      </div>
      <p>{detail}</p>
    </article>
  );
}

function formatWeatherTimestamp(value) {
  if (!value) return "Unavailable";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  }).format(date);
}

export default function Dashboard({ onBack }) {
  const [stations, setStations] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [search, setSearch] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [data, setData] = useState(null);
  const [loadingStations, setLoadingStations] = useState(true);
  const [loadingForecast, setLoadingForecast] = useState(false);
  const [error, setError] = useState("");
  const [stationError, setStationError] = useState("");

  useEffect(() => {
    let cancelled = false;

    fetchStations()
      .then((items) => {
        if (cancelled) return;
        setStations(items);

        const initial = items.find((station) => station.id === 17) || items[0];
        if (initial) {
          setSelectedId(String(initial.id));
          setSearch(initial.name);
        } else {
          setStationError("No monitoring locations were found in the dataset.");
        }
      })
      .catch((err) => {
        if (!cancelled) setStationError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingStations(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function loadForecast(locationId = selectedId) {
    if (!locationId) return;

    setLoadingForecast(true);
    setError("");
    setData(null);

    try {
      const response = await fetch(
        `${API_URL}/agent/advice/${encodeURIComponent(locationId)}`
      );

      if (!response.ok) {
        throw new Error(
          response.status === 404
            ? "A forecast is not available for this location yet."
            : `Forecast service returned ${response.status}.`
        );
      }

      setData(await response.json());
    } catch (err) {
      setError(
        `${err.message || "Could not load the forecast."} Check that the backend is running and this station has sufficient data.`
      );
    } finally {
      setLoadingForecast(false);
    }
  }

  useEffect(() => {
    if (selectedId) loadForecast(selectedId);
    // Forecast refreshes when the selected station changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const filteredStations = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return stations.slice(0, 8);

    return stations
      .filter((station) => station.name.toLowerCase().includes(query))
      .slice(0, 8);
  }, [stations, search]);

  function chooseStation(station) {
    setSelectedId(String(station.id));
    setSearch(station.name);
    setShowSuggestions(false);
  }

  const risk = getRisk(data?.risk_level);
  const hasPrediction =
    data && Number.isFinite(Number(data.predicted_pm25));

  return (
    <main className="dashboard-page">
      <nav className="dashboard-nav">
        <button className="brand-mark" onClick={onBack}>
          <span className="brand-icon">S</span>
          <span>SMOKEGUARD</span>
        </button>

        <div className="dashboard-nav-links">
          <span className="nav-link active">Air Outlook</span>
          <button className="nav-link" onClick={onBack}>Home</button>
        </div>

        <span className="nav-status"><i /> FORECAST CONSOLE</span>
      </nav>

      <section className="dashboard-heading">
        <div>
          <p className="dashboard-eyebrow">ENVIRONMENTAL INTELLIGENCE / 01</p>
          <h1>Air <span>Outlook.</span></h1>
          <p className="dashboard-description">
            Explore local air conditions and forecast pollution risk.
          </p>
        </div>

        <button
          className="refresh-button"
          onClick={() => loadForecast()}
          disabled={!selectedId || loadingForecast}
        >
          {loadingForecast ? "Updating forecast…" : "↻ Refresh forecast"}
        </button>
      </section>

      <section className="station-picker">
        <div className="station-picker-copy">
          <span className="section-overline">EXPLORE YOUR AREA</span>
          <h2>Where do you want to check the air?</h2>
          <p>Search by neighbourhood or monitoring station name.</p>
        </div>

        <div className="station-search">
          <label htmlFor="station-search-input">Area or station</label>
          <div className="station-input-wrap">
            <span aria-hidden="true">⌕</span>
            <input
              id="station-search-input"
              type="search"
              placeholder="e.g. R K Puram, Anand Vihar…"
              value={search}
              autoComplete="off"
              onFocus={() => setShowSuggestions(true)}
              onChange={(event) => {
                setSearch(event.target.value);
                setShowSuggestions(true);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") setShowSuggestions(false);
                if (event.key === "Enter" && filteredStations[0]) {
                  chooseStation(filteredStations[0]);
                }
              }}
            />
          </div>

          {showSuggestions && (
            <div className="station-suggestions">
              {loadingStations ? (
                <p className="suggestion-message">Loading locations…</p>
              ) : filteredStations.length ? (
                filteredStations.map((station) => (
                  <button
                    type="button"
                    className="station-suggestion"
                    key={station.id}
                    onClick={() => chooseStation(station)}
                  >
                    <span className="suggestion-pin">⌖</span>
                    <span>
                      <strong>{station.name}</strong>
                      <small>Latest observation: {station.date || "Date unavailable"}</small>
                    </span>
                    <span className="suggestion-arrow">↗</span>
                  </button>
                ))
              ) : (
                <p className="suggestion-message">
                  No matching area found in the available station dataset.
                </p>
              )}
            </div>
          )}

          {stationError && <p className="station-error">{stationError}</p>}
          <p className="station-count-note">
            {stations.length} monitoring locations in the available dataset
          </p>
        </div>
      </section>

      {loadingForecast && (
        <div className="dashboard-message">
          <span className="loading-dot" />
          Loading forecast for {search || "selected location"}…
        </div>
      )}

      {!loadingForecast && error && (
        <div className="dashboard-error">
          <strong>Forecast unavailable for this location</strong>
          <p>{error}</p>
          <button className="refresh-button" onClick={() => loadForecast()}>
            Try again
          </button>
        </div>
      )}

      {!loadingForecast && !error && !data && !loadingStations && (
        <div className="dashboard-message">
          Choose a monitoring location to view its forecast.
        </div>
      )}

      {!loadingForecast && !error && data && (
        <>
          <section className="dashboard-location-row">
            <div className="location-title">
              <span className="location-pin">⌖</span>
              <div>
                <span className="section-overline">SELECTED MONITORING LOCATION</span>
                <h2>{data.location}</h2>
                <p>Station ID {selectedId}</p>
              </div>
            </div>

            <div className="forecast-date">
              <span className="section-overline">FORECAST DATE</span>
              <strong>{data.forecast_date || "Unavailable"}</strong>
              <span>Model prediction</span>
            </div>
          </section>
        
<section className="data-freshness-panel">
  <div className="freshness-heading">
    <div>
      <span className="section-overline">DATA TRANSPARENCY</span>
      <h3>Fire source freshness</h3>
    </div>
    <span className="freshness-status">
      {data.fire_data_is_current ? "Sources recently updated" : "Some data is older"}
    </span>
  </div>

  <div className="freshness-grid">
    <div className="freshness-item">
      <span>PM2.5 observation</span>
      <strong>{data.latest_pm25_date || "Unavailable"}</strong>
      <small>
        {data.pm25_data_age_days != null
          ? `${data.pm25_data_age_days} day(s) old`
          : "Age unavailable"}
      </small>
    </div>

    <div className="freshness-item">
      <span>Weather observed</span>
      <strong>{formatWeatherTimestamp(data.weather_observed_at)}</strong>
      <small>{data.wind_source || "Weather source unavailable"}</small>
    </div>

    <div className="freshness-item">
      <span>Fire detections acquired</span>
      <strong>{data.fire_detection_date || "Unavailable"}</strong>
      <small>
        {data.fire_data_age_days != null
          ? `${data.fire_data_age_days} day(s) old`
          : "Age unavailable"}
      </small>
    </div>

    <div className="freshness-item">
      <span>Features regenerated</span>
      <strong>
        {data.fire_features_generated_at
          ? data.fire_features_generated_at.replace("T", " ").slice(0, 19)
          : "Unavailable"}
      </strong>
      <small>
        {data.fire_detection_rows_used != null
          ? `${data.fire_detection_rows_used} source detections`
          : "Source count unavailable"}
      </small>
    </div>
  </div>

  {!data.fire_data_is_current && (
    <p className="freshness-warning">
      Feature calculations were regenerated, but the source feed has not been
      verified as current. Fire detections may be incomplete or outdated, so
      predictions may not reflect the latest pollution or fire conditions.
    </p>
  )}
</section>

          <section className="dashboard-grid">
            <article className="featured-risk-card">
              <div className="featured-card-header">
                <span className="section-overline">PREDICTED PM2.5</span>
                <span
                  className="risk-badge"
                  style={{
                    color: risk.color,
                    borderColor: `${risk.color}70`,
                    background: `${risk.color}14`,
                  }}
                >
                  <i style={{ background: risk.color }} />
                  {risk.title}
                </span>
              </div>

              <div className="featured-pm">
                {hasPrediction ? Number(data.predicted_pm25).toFixed(1) : "—"}
                <span>µg/m³</span>
              </div>

              <p className="featured-caption">
                Estimated fine-particle concentration from the SmokeGuard model.
                This is a prediction, not a direct measurement.
              </p>

              <div className="risk-scale">
                {[
                  ["Low", "#36c995"],
                  ["Moderate", "#f2c653"],
                  ["High", "#ff8a4c"],
                  ["Very High", "#ff4d78"],
                ].map(([label, color]) => (
                  <div className="risk-scale-item" key={label}>
                    <i style={{ background: color }} />
                    <span>{label}</span>
                  </div>
                ))}
              </div>
            </article>

            <MetricCard
              label="LATEST OBSERVED PM2.5"
              value={
                data.latest_pm25_observation != null
                  ? Number(data.latest_pm25_observation).toFixed(1)
                  : "—"
              }
              unit="µg/m³"
              detail={
                data.latest_pm25_date
                  ? `Measured on ${data.latest_pm25_date}; latest available observation`
                  : "No observation date returned"
              }
              accent="#e88ba0"
            />

            <MetricCard
              label="WIND SPEED"
              value={data.wind_speed_kmh != null ? Number(data.wind_speed_kmh).toFixed(1) : "—"}
              unit="km/h"
              detail={
                data.wind_direction_deg != null
                  ? `Direction: ${data.wind_direction_deg}° clockwise from north`
                  : "Wind direction unavailable"
              }
              accent="#8bc9ff"
            />

            <MetricCard
              label="DOWNWIND FIRE DETECTIONS · 50 KM"
              value={data.downwind_fires_50km ?? "—"}
              detail="Satellite detections classified as downwind within 50 km; not necessarily unique incidents."
              accent="#ff8a4c"
            />

            <MetricCard
              label="CLOSEST DOWNWIND FIRE"
              value={
                data.closest_downwind_fire_km != null &&
                Number.isFinite(Number(data.closest_downwind_fire_km))
                  ? Number(data.closest_downwind_fire_km).toFixed(1)
                  : "—"
              }
              unit={data.closest_downwind_fire_km != null ? "km" : ""}
              detail="Distance to the nearest detected downwind fire in the analysis."
              accent="#ff6d88"
            />
          </section>

          <section className="dashboard-bottom-grid">
            <article className="insight-panel">
              <div className="panel-heading">
                <div>
                  <span className="section-overline">MODEL ASSESSMENT</span>
                  <h3>What the forecast suggests</h3>
                </div>
                <span className="panel-symbol">↗</span>
              </div>
              <p>
                {data.assessment ||
                  "The service did not return an assessment for this forecast."}
              </p>
              <div className="data-note">
                <span className="note-dot" />
                Predictions are estimates and can differ from measured conditions.
              </div>
            </article>

            <article
              className="recommendation-panel recommendation-highlight"
              style={{ "--action-color": risk.color }}
            >
              <div className="action-topline">
                <span className="section-overline">YOUR RECOMMENDED ACTION</span>
                <span className="action-risk">{risk.title}</span>
              </div>

              <div className="recommendation-icon">✳</div>
              <h3>{risk.action}</h3>
              <p>
                {data.recommendation ||
                  "Check current local air-quality guidance before deciding on outdoor activities."}
              </p>
              <div className="action-footnote">
                <span />
                Advice based on the model's risk category, not a medical assessment.
              </div>
            </article>
          </section>

          <footer className="dashboard-footer">
            <span>SMOKEGUARD / AIR INTELLIGENCE</span>
            <span>PM2.5 concentration is reported in µg/m³</span>
          </footer>
        </>
      )}
    </main>
  );
}
