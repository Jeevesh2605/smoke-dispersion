from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import urlencode
from datetime import datetime
import json
import ssl

import certifi
import pandas as pd
from strands import tool

from tools.predict_pm25 import predict_pm25
from tools.location import get_location_metadata

PROJECT_ROOT = Path(__file__).resolve().parents[2]
AQI_FILE = PROJECT_ROOT / "data/raw/aqi_recent.csv"
FIRE_FEATURE_FILE = PROJECT_ROOT / "data/processed/today_fire_features.csv"
FIRE_METADATA_FILE = PROJECT_ROOT / "data/processed/today_fire_features_metadata.json"


def fetch_location_wind(latitude: float, longitude: float) -> dict:
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

    with urlopen(request, timeout=15, context=context) as response:
        payload = json.loads(response.read().decode("utf-8"))

    current = payload.get("current")
    if not current:
        raise ValueError("Weather API returned no current conditions.")

    speed = current.get("wind_speed_10m")
    direction = current.get("wind_direction_10m")
    if speed is None or direction is None:
        raise ValueError("Wind speed or direction is unavailable.")

    return {
        "wind_speed_kmh": float(speed),
        "wind_direction_deg": float(direction),
        "weather_observed_at": current.get("time"),
        "wind_source": "Open-Meteo",
    }


@tool
def forecast_today(location_id: int) -> dict:
    """Predict PM2.5 using recent observations, local wind and stored fire features."""
    try:
        location = get_location_metadata(location_id)
        wind = fetch_location_wind(
            float(location["latitude"]),
            float(location["longitude"]),
        )

        aqi = pd.read_csv(AQI_FILE)
        aqi["location_id"] = pd.to_numeric(
            aqi["location_id"], errors="coerce"
        )
        aqi["date"] = pd.to_datetime(aqi["date"], errors="coerce")

        rows = (
            aqi[
                (aqi["location_id"] == int(location_id))
                & aqi["date"].notna()
            ]
            .sort_values("date")
            .dropna(subset=["pm25"])
            .reset_index(drop=True)
        )
        if len(rows) < 7:
            return {
                "error": "Not enough recent PM2.5 observations for this station.",
                "location": location["location_name"],
            }

        latest = rows.iloc[-1]
        pm25_lag_1 = float(rows.iloc[-1]["pm25"])
        pm25_lag_3 = float(rows.iloc[-3]["pm25"])
        pm25_lag_7 = float(rows.iloc[-7]["pm25"])

        fire = pd.read_csv(FIRE_FEATURE_FILE)
        fire["location_id"] = pd.to_numeric(
            fire["location_id"], errors="coerce"
        )
        fire_rows = fire[fire["location_id"] == int(location_id)]
        if fire_rows.empty:
            return {
                "error": "No fire-dispersion features found for this station.",
                "location": location["location_name"],
            }
        fire_row = fire_rows.iloc[0]

        fire_metadata = {}
        if FIRE_METADATA_FILE.exists():
            fire_metadata = json.loads(
                FIRE_METADATA_FILE.read_text(encoding="utf-8")
            )

        prediction = predict_pm25(
            location_id=int(location_id),
            pm25_lag_1=pm25_lag_1,
            pm25_lag_3=pm25_lag_3,
            pm25_lag_7=pm25_lag_7,
            wind_speed_kmh=wind["wind_speed_kmh"],
            wind_direction_deg=wind["wind_direction_deg"],
            downwind_fire_count_50km=int(
                fire_row["downwind_fire_count_50km"]
            ),
            downwind_fire_count_100km=int(
                fire_row["downwind_fire_count_100km"]
            ),
            downwind_fire_count_200km=int(
                fire_row["downwind_fire_count_200km"]
            ),
            fire_intensity_50km=float(fire_row["fire_intensity_50km"]),
            fire_intensity_100km=float(fire_row["fire_intensity_100km"]),
            fire_intensity_200km=float(fire_row["fire_intensity_200km"]),
            closest_downwind_fire_km=float(
                fire_row["closest_downwind_fire_km"]
            ),
        )

        if prediction < 60:
            risk = "Low"
        elif prediction < 120:
            risk = "Moderate"
        elif prediction < 250:
            risk = "High"
        else:
            risk = "Very High"

        fire_date = fire_metadata.get("fire_detection_date_used")
        generated_at = fire_metadata.get("generated_at")
        latest_pm_date = str(latest["date"].date())

        # This indicates source-data age, not whether the feature builder ran.
        try:
            fire_age_days = (
                datetime.now().date()
                - datetime.strptime(fire_date, "%Y-%m-%d").date()
            ).days if fire_date else None
        except ValueError:
            fire_age_days = None

        return {
            "location": location["location_name"],
            "location_id": int(location_id),
            "forecast_date": (
                wind["weather_observed_at"][:10]
                if wind["weather_observed_at"] else None
            ),
            "predicted_pm25": round(float(prediction), 2),
            "unit": "µg/m³",
            "risk_level": risk,
            "latest_pm25_observation": pm25_lag_1,
            "latest_pm25_date": latest_pm_date,
            "pm25_data_age_days": (
                (datetime.now().date() - latest["date"].date()).days
            ),
            "wind_speed_kmh": wind["wind_speed_kmh"],
            "wind_direction_deg": wind["wind_direction_deg"],
            "wind_source": wind["wind_source"],
            "weather_observed_at": wind["weather_observed_at"],
            "downwind_fires_50km": int(
                fire_row["downwind_fire_count_50km"]
            ),
            "downwind_fires_100km": int(
                fire_row["downwind_fire_count_100km"]
            ),
            "downwind_fires_200km": int(
                fire_row["downwind_fire_count_200km"]
            ),
            "closest_downwind_fire_km": round(
                float(fire_row["closest_downwind_fire_km"]), 2
            ),
            "fire_data_source": fire_metadata.get(
                "fire_source_file", "Unknown"
            ),
            "fire_detection_date": fire_date,
            "fire_features_generated_at": generated_at,
            "fire_detection_rows_used": fire_metadata.get(
                "fire_detection_rows_used"
            ),
            "fire_data_age_days": fire_age_days,
            "fire_data_is_current": (
                fire_metadata.get("fire_data_is_current") is True
                and fire_age_days is not None
                and 0 <= fire_age_days <= 1
            ),
        }

    except Exception as exc:
        return {
            "error": f"Forecast generation failed: {exc}",
            "location_id": int(location_id),
        }
