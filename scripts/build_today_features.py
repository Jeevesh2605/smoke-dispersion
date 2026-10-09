from pathlib import Path
from datetime import datetime
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import json
import ssl
import time
from urllib.error import HTTPError, URLError

import certifi
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
FIRE_FILE = ROOT / "data/raw/firms_nrt.csv"
LOCATION_FILE = ROOT / "data/processed/location_metadata.csv"
OUTPUT_FILE = ROOT / "data/processed/today_fire_features.csv"
METADATA_FILE = ROOT / "data/processed/today_fire_features_metadata.json"


def haversine(lat1, lon1, lat2, lon2):
    radius = 6371.0
    lat1, lon1, lat2, lon2 = map(
        np.radians, [lat1, lon1, lat2, lon2]
    )
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = (
        np.sin(dlat / 2) ** 2
        + np.cos(lat1) * np.cos(lat2) * np.sin(dlon / 2) ** 2
    )
    return 2 * radius * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


def bearing(fire_lat, fire_lon, station_lat, station_lon):
    lat1 = np.radians(fire_lat)
    lat2 = np.radians(station_lat)
    dlon = np.radians(station_lon - fire_lon)
    y = np.sin(dlon) * np.cos(lat2)
    x = (
        np.cos(lat1) * np.sin(lat2)
        - np.sin(lat1) * np.cos(lat2) * np.cos(dlon)
    )
    return (np.degrees(np.arctan2(y, x)) + 360) % 360


def fetch_wind(latitude, longitude):
    params = urlencode({
        "latitude": latitude,
        "longitude": longitude,
        "current": "wind_speed_10m,wind_direction_10m",
        "timezone": "Asia/Kolkata",
    })
    request = Request(
        f"https://api.open-meteo.com/v1/forecast?{params}",
        headers={"User-Agent": "SmokeGuard/1.0"},
    )
    context = ssl.create_default_context(cafile=certifi.where())
    last_error = None

    for attempt in range(3):
        try:
            with urlopen(request, timeout=20, context=context) as response:
                payload = json.loads(response.read().decode("utf-8"))

            current = payload.get("current", {})
            speed = current.get("wind_speed_10m")
            direction = current.get("wind_direction_10m")

            if speed is None or direction is None:
                raise ValueError(
                    f"Wind unavailable for coordinates {latitude}, {longitude}"
                )

            return {
                "speed": float(speed),
                "direction": float(direction),
                "observed_at": current.get("time"),
            }

        except HTTPError as exc:
            last_error = exc
            if exc.code not in (429, 500, 502, 503, 504):
                raise
        except (URLError, TimeoutError) as exc:
            last_error = exc

        if attempt < 2:
            delay = 2 ** (attempt + 1)
            print(
                f"Wind API retry {attempt + 1}/3 after "
                f"{type(last_error).__name__}; waiting {delay}s"
            )
            time.sleep(delay)

    raise RuntimeError(
        f"Wind API failed after 3 attempts for "
        f"{latitude}, {longitude}: {last_error}"
    )


def main():
    # Validate inputs before touching the existing output files.
    if not FIRE_FILE.exists():
        raise FileNotFoundError(
            f"{FIRE_FILE} not found. Obtain the FIRMS NRT data first; "
            "the old historical fires.csv is not a live replacement."
        )

    fires = pd.read_csv(FIRE_FILE)
    locations = pd.read_csv(LOCATION_FILE)

    required_fire_columns = {
        "latitude", "longitude", "frp", "acq_date"
    }
    if not required_fire_columns.issubset(fires.columns):
        raise ValueError(
            f"FIRMS file must contain {sorted(required_fire_columns)}"
        )

    fires["acq_date"] = pd.to_datetime(
        fires["acq_date"], errors="coerce"
    ).dt.strftime("%Y-%m-%d")
    fires["latitude"] = pd.to_numeric(fires["latitude"], errors="coerce")
    fires["longitude"] = pd.to_numeric(fires["longitude"], errors="coerce")
    fires["frp"] = pd.to_numeric(fires["frp"], errors="coerce").fillna(0)
    fires = fires.dropna(
        subset=["acq_date", "latitude", "longitude"]
    )

    if fires.empty:
        raise ValueError("FIRMS file contains no valid fire detections.")

    # Use the most recent date present in the source, not a hardcoded date.
    fire_date = fires["acq_date"].max()
    fires = fires[fires["acq_date"] == fire_date].copy()

    if locations.empty:
        raise ValueError("Location metadata contains no stations.")

    results = []
    weather_times = []

    # Build all rows in memory first. A failed weather request will not
    # overwrite the previously working feature file.
    for _, loc in locations.iterrows():
        wind = fetch_wind(
            float(loc["latitude"]), float(loc["longitude"])
        )
        weather_times.append(wind["observed_at"])

        distances = haversine(
            fires["latitude"].to_numpy(),
            fires["longitude"].to_numpy(),
            float(loc["latitude"]),
            float(loc["longitude"]),
        )

        nearby = distances <= 300
        fire_subset = fires.loc[nearby].copy()
        dist = distances[nearby]

        if fire_subset.empty:
            downwind = np.array([], dtype=bool)
            weighted = np.array([], dtype=float)
        else:
            bearings = bearing(
                fire_subset["latitude"].to_numpy(),
                fire_subset["longitude"].to_numpy(),
                float(loc["latitude"]),
                float(loc["longitude"]),
            )
            smoke_direction = (wind["direction"] + 180) % 360
            angle = np.abs(
                (bearings - smoke_direction + 180) % 360 - 180
            )
            downwind = angle <= 45
            weighted = fire_subset["frp"].to_numpy() / (dist + 1)

        row = {"location_id": int(loc["location_id"])}

        for radius in (50, 100, 200):
            mask = downwind & (dist <= radius)
            row[f"downwind_fire_count_{radius}km"] = int(mask.sum())
            row[f"fire_intensity_{radius}km"] = float(weighted[mask].sum())

        row["closest_downwind_fire_km"] = (
            round(float(dist[downwind].min()), 2)
            if downwind.any() else 999.0
        )
        results.append(row)

        print(
            f'{loc["location_name"]}: wind {wind["speed"]:.1f} km/h, '
            f'{wind["direction"]:.0f}°, weather time {wind["observed_at"]}'
        )

    result = pd.DataFrame(results)

    metadata = {
        "generated_at": datetime.now().astimezone().isoformat(),
        "fire_source_file": str(FIRE_FILE.relative_to(ROOT)),
        "fire_detection_date_used": fire_date,
        "fire_detection_rows_used": int(len(fires)),
        "fire_data_is_current": False,
        "weather_source": "Open-Meteo current weather API",
        "weather_observed_at": sorted({
            t for t in weather_times if t is not None
        }),
        "station_count": int(len(result)),
        "note": (
            "The detection date is the newest date in the local FIRMS file; "
            "it is not proof that the file itself is up to date."
        ),
    }

    # Replace outputs only after all station requests and calculations succeed.
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    result.to_csv(OUTPUT_FILE, index=False)
    METADATA_FILE.write_text(json.dumps(metadata, indent=2) + "\n")

    print(f"\nSaved features: {OUTPUT_FILE}")
    print(f"Saved metadata: {METADATA_FILE}")
    print(f"Latest fire detection date in local file: {fire_date}")
    print(f"Detection rows used: {len(fires)}")
    print(f"Stations processed: {len(result)}")
    print(result[result["location_id"].isin([17, 50, 235])].to_string(index=False))


if __name__ == "__main__":
    main()
