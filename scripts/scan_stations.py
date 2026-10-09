"""
Tile a grid of search points across the whole NCR region (instead of one
query per city) to find every distinct PM2.5 station, then filter to the
ones whose reporting lifetime actually overlaps your target date window.

This replaces the per-city approach, which kept re-finding the same 2-3
overlapping stations due to how close Delhi/Noida/Gurugram/Ghaziabad are
to each other.

Usage:
    python scan_stations.py --start 2024-10-01 --end 2024-12-15 \
        --out ../data/raw/candidate_stations.csv
"""
import os
import time
import argparse
import requests
import pandas as pd

BASE_URL = "https://api.openaq.org/v3"

# Grid of (lat, lon) centers tiling the broader Delhi-NCR region:
# Delhi, Noida, Gurugram, Ghaziabad, Faridabad, and a bit further out
# (Sonipat/Bahadurgarh direction) to catch anything the city-center
# searches missed.
GRID_POINTS = [
    (28.90, 76.95), (28.90, 77.20), (28.90, 77.45),
    (28.65, 76.95), (28.65, 77.20), (28.65, 77.45),
    (28.40, 76.95), (28.40, 77.20), (28.40, 77.45),
]


def get_headers():
    api_key = os.environ.get("OPENAQ_API_KEY")
    if not api_key:
        raise RuntimeError("Set the OPENAQ_API_KEY environment variable first.")
    return {"X-API-Key": api_key}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", required=True, help="YYYY-MM-DD")
    parser.add_argument("--end", required=True, help="YYYY-MM-DD")
    parser.add_argument("--out", default="../data/raw/candidate_stations.csv")
    args = parser.parse_args()

    headers = get_headers()
    window_start = pd.Timestamp(args.start, tz="Asia/Kolkata")
    window_end = pd.Timestamp(args.end, tz="Asia/Kolkata")

    seen = {}  # location_id -> record, deduped across all grid points
    for lat, lon in GRID_POINTS:
        params = {"coordinates": f"{lat},{lon}", "radius": 25000, "limit": 100}
        resp = requests.get(f"{BASE_URL}/locations", headers=headers, params=params, timeout=30)
        resp.raise_for_status()
        for loc in resp.json()["results"]:
            if loc["id"] in seen:
                continue
            pm25_sensors = [
                s for s in loc.get("sensors", [])
                if s.get("parameter", {}).get("name") == "pm25"
            ]
            if not pm25_sensors:
                continue
            first = loc.get("datetimeFirst")
            last = loc.get("datetimeLast")
            if not first or not last:
                continue
            first_ts = pd.Timestamp(first["local"])
            last_ts = pd.Timestamp(last["local"])
            # keep only stations whose reporting lifetime overlaps our window
            if last_ts < window_start or first_ts > window_end:
                continue
            seen[loc["id"]] = {
                "location_id": loc["id"],
                "location_name": loc.get("name"),
                "latitude": loc["coordinates"]["latitude"],
                "longitude": loc["coordinates"]["longitude"],
                "lifetime_first": first["local"],
                "lifetime_last": last["local"],
            }
        time.sleep(1.1)

    df = pd.DataFrame(list(seen.values()))
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    df.to_csv(args.out, index=False)
    print(f"Found {len(df)} distinct stations whose lifetime overlaps "
          f"{args.start} to {args.end}")
    print(df[["location_id", "location_name", "latitude", "longitude"]].to_string(index=False))
    print(f"\nSaved to {args.out}")


if __name__ == "__main__":
    main()