import pandas as pd


FIRE_FILE = "../data/raw/fires.csv"
WIND_FILE = "../data/raw/wind_station_raw.csv"


def get_environment_snapshot(
    latitude: float,
    longitude: float,
) -> dict:
    """
    Get recent fire activity and wind conditions around a location.

    Returns a compact environmental snapshot for the pollution agent.
    """

    fires = pd.read_csv(FIRE_FILE)
    wind = pd.read_csv(WIND_FILE)

    # Use the most recent available fire observation
    latest_fire_date = fires["acq_date"].max()

    recent_fires = fires[fires["acq_date"] == latest_fire_date].copy()

    # Approximate distance using latitude/longitude differences.
    # This is only for contextual reporting, not model feature generation.
    lat_diff = (recent_fires["latitude"] - latitude) * 111
    lon_diff = (
        (recent_fires["longitude"] - longitude)
        * 111
        * 0.88
    )

    recent_fires["distance_km"] = (
        lat_diff**2 + lon_diff**2
    ) ** 0.5

    nearby = recent_fires[
        recent_fires["distance_km"] <= 200
    ]

    # Get latest wind observation for the closest station
    wind["station_distance"] = (
        ((wind["latitude"] - latitude) * 111) ** 2
        + ((wind["longitude"] - longitude) * 111 * 0.88) ** 2
    ) ** 0.5

    closest_station = wind.loc[
        wind["station_distance"].idxmin()
    ]

    return {
        "fire_data_date": latest_fire_date,
        "nearby_fire_count_200km": int(len(nearby)),
        "nearby_fire_count_100km": int(
            (nearby["distance_km"] <= 100).sum()
        ),
        "nearby_fire_count_50km": int(
            (nearby["distance_km"] <= 50).sum()
        ),
        "wind_speed_kmh": float(
            closest_station["wind_speed_kmh"]
        ),
        "wind_direction_deg": float(
            closest_station["wind_direction_deg"]
        ),
        "wind_station_distance_km": float(
            closest_station["station_distance"]
        ),
    }