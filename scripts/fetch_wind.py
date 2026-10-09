"""
Fetch historical daily wind data for every AQI monitoring station.

Reads station coordinates from:
    data/raw/aqi_raw.csv

Fetches:
    2024-10-01 -> 2025-12-15

Outputs:
    data/raw/wind_station_raw.csv
"""

import os
import time
import requests
import pandas as pd

BASE_URL = "https://archive-api.open-meteo.com/v1/archive"

START_DATE = "2024-10-01"
END_DATE = "2025-12-15"

AQI_FILE = "data/raw/aqi_raw.csv"
OUTPUT_FILE = "data/raw/wind_station_raw.csv"


def fetch_station_wind(session, station):
    """Fetch daily wind data for one station."""

    params = {
        "latitude": station["latitude"],
        "longitude": station["longitude"],
        "start_date": START_DATE,
        "end_date": END_DATE,
        "daily": "wind_speed_10m_max,wind_direction_10m_dominant",
        "timezone": "Asia/Kolkata",
    }

    response = session.get(BASE_URL, params=params, timeout=60)
    response.raise_for_status()

    daily = response.json()["daily"]

    df = pd.DataFrame({
        "location_id": station["location_id"],
        "location_name": station["location_name"],
        "latitude": station["latitude"],
        "longitude": station["longitude"],
        "date": daily["time"],
        "wind_speed_kmh": daily["wind_speed_10m_max"],
        "wind_direction_deg": daily["wind_direction_10m_dominant"],
    })

    return df


def main():

    print("Reading AQI stations...")

    aqi = pd.read_csv(AQI_FILE)

    stations = (
        aqi[
            [
                "location_id",
                "location_name",
                "latitude",
                "longitude",
            ]
        ]
        .drop_duplicates("location_id")
        .sort_values("location_id")
    )

    print(f"Found {len(stations)} stations")
    print(f"Date range: {START_DATE} -> {END_DATE}")
    print()

    all_wind = []

    with requests.Session() as session:

        for i, (_, station) in enumerate(stations.iterrows(), start=1):

            print(
                f"[{i}/{len(stations)}] "
                f"{station['location_id']} - "
                f"{station['location_name']}"
            )

            try:
                wind = fetch_station_wind(session, station)
                all_wind.append(wind)

                print(f"    ✓ {len(wind)} daily records")

            except Exception as e:
                print(f"    ✗ ERROR: {e}")

            # Small delay between API requests
            time.sleep(0.2)

    if not all_wind:
        raise RuntimeError("No wind data was downloaded.")

    result = pd.concat(all_wind, ignore_index=True)

    result["date"] = pd.to_datetime(result["date"])

    result = result.sort_values(
        ["location_id", "date"]
    )

    os.makedirs(
        os.path.dirname(OUTPUT_FILE),
        exist_ok=True
    )

    result.to_csv(
        OUTPUT_FILE,
        index=False
    )

    print()
    print("=" * 60)
    print("DONE")
    print("=" * 60)
    print(f"Stations: {result['location_id'].nunique()}")
    print(f"Rows:     {len(result)}")
    print(
        f"Dates:    {result['date'].min().date()} "
        f"-> {result['date'].max().date()}"
    )
    print(f"Saved:    {OUTPUT_FILE}")


if __name__ == "__main__":
    main()