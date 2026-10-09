"""
Pull daily PM2.5 history for a specific list of stations (from
scan_stations.py's output), instead of searching by city center again.

Usage:
    python fetch_aqi_by_stations.py \
        --stations ../data/raw/candidate_stations.csv \
        --start 2024-10-01 --end 2024-12-15 \
        --out ../data/raw/aqi_raw.csv
"""
import os
import time
import argparse
import requests
import pandas as pd

BASE_URL = "https://api.openaq.org/v3"


def get_headers():
    api_key = os.environ.get("OPENAQ_API_KEY")
    if not api_key:
        raise RuntimeError("Set the OPENAQ_API_KEY environment variable first.")
    return {"X-API-Key": api_key}


def get_pm25_sensor_ids(location_id, headers):
    url = f"{BASE_URL}/locations/{location_id}/sensors"
    resp = requests.get(url, headers=headers, timeout=30)
    resp.raise_for_status()
    sensors = resp.json()["results"]
    return [
        s["id"] for s in sensors
        if s.get("parameter", {}).get("name") == "pm25"
    ]


def get_daily_measurements(sensor_id, start, end, headers):
    url = f"{BASE_URL}/sensors/{sensor_id}/days"
    params = {"date_from": start, "date_to": end, "limit": 1000}
    resp = requests.get(url, headers=headers, params=params, timeout=30)
    resp.raise_for_status()
    return resp.json()["results"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--stations", required=True)
    parser.add_argument("--start", required=True)
    parser.add_argument("--end", required=True)
    parser.add_argument("--out", default="../data/raw/aqi_raw.csv")
    args = parser.parse_args()

    headers = get_headers()
    stations = pd.read_csv(args.stations)

    rows = []
    for _, station in stations.iterrows():
        loc_id = station["location_id"]
        try:
            sensor_ids = get_pm25_sensor_ids(loc_id, headers)
        except Exception as e:
            print(f"  skipping station {loc_id}: {e}")
            continue

        station_rows = 0
        for sid in sensor_ids:
            try:
                daily = get_daily_measurements(sid, args.start, args.end, headers)
            except Exception as e:
                print(f"  skipping sensor {sid}: {e}")
                continue
            for d in daily:
                rows.append({
                    "location_id": loc_id,
                    "location_name": station["location_name"],
                    "latitude": station["latitude"],
                    "longitude": station["longitude"],
                    "date": d["period"]["datetimeFrom"]["local"][:10],
                    "pm25": d.get("value"),
                })
                station_rows += 1
            time.sleep(1.1)

        print(f"{station['location_name']} (id {loc_id}): {station_rows} rows")

    df = pd.DataFrame(rows)
    if not df.empty:
        # average duplicate same-day readings from multiple sensors at one station
        df = df.groupby(
            ["location_id", "location_name", "latitude", "longitude", "date"],
            as_index=False
        )["pm25"].mean()

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    df.to_csv(args.out, index=False)
    print(f"\nSaved {len(df)} total rows to {args.out}")
    print(f"Distinct stations with data: {df['location_id'].nunique() if not df.empty else 0}")


if __name__ == "__main__":
    main()