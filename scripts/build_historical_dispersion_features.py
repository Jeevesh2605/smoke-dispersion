import numpy as np
import pandas as pd


# ============================================================
# Paths
# ============================================================

AQI_PATH = "data/processed/training_data_historical.csv"
STATION_PATH = "data/raw/aqi_raw.csv"
FIRE_PATH = "data/raw/fires_historical.csv"

OUTPUT_PATH = "data/processed/training_data_historical_dispersion.csv"


# ============================================================
# Geographic utilities
# ============================================================

def haversine_km(lat1, lon1, lat2, lon2):
    """Calculate distance between geographic coordinates in km."""

    R = 6371.0

    lat1 = np.radians(lat1)
    lon1 = np.radians(lon1)
    lat2 = np.radians(lat2)
    lon2 = np.radians(lon2)

    dlat = lat2 - lat1
    dlon = lon2 - lon1

    a = (
        np.sin(dlat / 2) ** 2
        + np.cos(lat1)
        * np.cos(lat2)
        * np.sin(dlon / 2) ** 2
    )

    return 2 * R * np.arcsin(np.sqrt(a))


def calculate_bearing(
    fire_lat,
    fire_lon,
    station_lat,
    station_lon
):
    """
    Calculate bearing from fire -> station.

    0   = North
    90  = East
    180 = South
    270 = West
    """

    lat1 = np.radians(fire_lat)
    lat2 = np.radians(station_lat)

    dlon = np.radians(station_lon - fire_lon)

    y = np.sin(dlon) * np.cos(lat2)

    x = (
        np.cos(lat1) * np.sin(lat2)
        - np.sin(lat1)
        * np.cos(lat2)
        * np.cos(dlon)
    )

    bearing = np.degrees(np.arctan2(y, x))

    return (bearing + 360) % 360


# ============================================================
# Main
# ============================================================

def main():

    print("Loading data...")

    # ---------------------------------------------------------
    # Load datasets
    # ---------------------------------------------------------

    aqi = pd.read_csv(AQI_PATH)
    fires = pd.read_csv(FIRE_PATH)
    stations = pd.read_csv(STATION_PATH)

    print(f"AQI rows  : {len(aqi):,}")
    print(f"Fire rows : {len(fires):,}")

    # ---------------------------------------------------------
    # Normalize dates
    # ---------------------------------------------------------

    aqi["date"] = pd.to_datetime(aqi["date"])
    fires["acq_date"] = pd.to_datetime(fires["acq_date"])

    # ---------------------------------------------------------
    # Get station coordinates
    # ---------------------------------------------------------

    stations = (
        stations[
            [
                "location_id",
                "latitude",
                "longitude"
            ]
        ]
        .drop_duplicates("location_id")
    )

    aqi = aqi.merge(
        stations,
        on="location_id",
        how="left",
        validate="many_to_one"
    )

    # ---------------------------------------------------------
    # Validate station coordinates and historical wind
    # ---------------------------------------------------------

    missing_coordinates = (
        aqi["latitude"].isna()
        | aqi["longitude"].isna()
    ).sum()

    missing_wind = aqi["wind_direction_mean"].isna().sum()

    print(
        f"Missing station coordinates : {missing_coordinates}"
    )

    print(
        f"Missing wind direction      : {missing_wind}"
    )

    if missing_coordinates > 0:
        raise ValueError(
            "Some stations are missing latitude/longitude."
        )

    if missing_wind > 0:
        raise ValueError(
            "Some station-days are missing wind direction."
        )

    # ---------------------------------------------------------
    # Fire preparation
    # ---------------------------------------------------------

    fires["frp"] = pd.to_numeric(
        fires["frp"],
        errors="coerce"
    ).fillna(0)

    # Group fires by acquisition date
    fire_groups = {
        date: group
        for date, group in fires.groupby("acq_date")
    }

    # ---------------------------------------------------------
    # Feature calculation
    # ---------------------------------------------------------

    new_features = []

    total_rows = len(aqi)

    for idx, row in aqi.iterrows():

        if idx % 2000 == 0:
            print(
                f"Processing {idx:,}/{total_rows:,}"
            )

        station_lat = row["latitude"]
        station_lon = row["longitude"]

        # -----------------------------------------------------
        # Previous day's fires
        # -----------------------------------------------------

        previous_date = (
            row["date"]
            - pd.to_timedelta(1, unit="D")
        )

        day_fires = fire_groups.get(previous_date)

        # -----------------------------------------------------
        # No fires
        # -----------------------------------------------------

        if day_fires is None or len(day_fires) == 0:

            new_features.append({
                "downwind_fire_count_50km": 0,
                "downwind_fire_count_100km": 0,
                "downwind_fire_count_200km": 0,
                "fire_intensity_50km": 0.0,
                "fire_intensity_100km": 0.0,
                "fire_intensity_200km": 0.0,
                "closest_downwind_fire_km": np.nan,
            })

            continue

        # -----------------------------------------------------
        # Calculate distance from every fire to station
        # -----------------------------------------------------

        distances = haversine_km(
            day_fires["latitude"].to_numpy(),
            day_fires["longitude"].to_numpy(),
            station_lat,
            station_lon,
        )

        # Only consider fires within 300 km
        nearby_mask = distances <= 300

        if not np.any(nearby_mask):

            new_features.append({
                "downwind_fire_count_50km": 0,
                "downwind_fire_count_100km": 0,
                "downwind_fire_count_200km": 0,
                "fire_intensity_50km": 0.0,
                "fire_intensity_100km": 0.0,
                "fire_intensity_200km": 0.0,
                "closest_downwind_fire_km": np.nan,
            })

            continue

        nearby = day_fires.loc[nearby_mask].copy()

        nearby_distances = distances[nearby_mask]

        # -----------------------------------------------------
        # Calculate fire -> station bearing
        # -----------------------------------------------------

        bearings = calculate_bearing(
            nearby["latitude"].to_numpy(),
            nearby["longitude"].to_numpy(),
            station_lat,
            station_lon,
        )

        # -----------------------------------------------------
        # Historical meteorological wind direction
        #
        # Wind direction tells us where the wind comes FROM.
        #
        # Smoke travels approximately in the opposite direction.
        # -----------------------------------------------------

        wind_direction = row["wind_direction_mean"]

        smoke_direction = (
            wind_direction + 180
        ) % 360

        # -----------------------------------------------------
        # Angular difference between:
        #
        # fire -> station direction
        # smoke movement direction
        # -----------------------------------------------------

        angle_difference = np.abs(
            (
                bearings
                - smoke_direction
                + 180
            ) % 360
            - 180
        )

        # Consider fire downwind if within ±45 degrees
        downwind_mask = angle_difference <= 45

        # -----------------------------------------------------
        # Downwind fire counts
        # -----------------------------------------------------

        count_50 = np.sum(
            downwind_mask
            & (nearby_distances <= 50)
        )

        count_100 = np.sum(
            downwind_mask
            & (nearby_distances <= 100)
        )

        count_200 = np.sum(
            downwind_mask
            & (nearby_distances <= 200)
        )

        # -----------------------------------------------------
        # Distance-weighted FRP
        #
        # Closer fires contribute more.
        # -----------------------------------------------------

        frp = nearby["frp"].to_numpy()

        weighted_intensity = (
            frp
            / (nearby_distances + 1)
        )

        intensity_50 = weighted_intensity[
            downwind_mask
            & (nearby_distances <= 50)
        ].sum()

        intensity_100 = weighted_intensity[
            downwind_mask
            & (nearby_distances <= 100)
        ].sum()

        intensity_200 = weighted_intensity[
            downwind_mask
            & (nearby_distances <= 200)
        ].sum()

        # -----------------------------------------------------
        # Closest downwind fire
        # -----------------------------------------------------

        downwind_distances = (
            nearby_distances[downwind_mask]
        )

        if len(downwind_distances) > 0:
            closest_downwind = (
                downwind_distances.min()
            )
        else:
            closest_downwind = np.nan

        # -----------------------------------------------------
        # Store features
        # -----------------------------------------------------

        new_features.append({
            "downwind_fire_count_50km": int(count_50),
            "downwind_fire_count_100km": int(count_100),
            "downwind_fire_count_200km": int(count_200),
            "fire_intensity_50km": float(intensity_50),
            "fire_intensity_100km": float(intensity_100),
            "fire_intensity_200km": float(intensity_200),
            "closest_downwind_fire_km": float(
                closest_downwind
            ),
        })

    # ---------------------------------------------------------
    # Combine features with original dataset
    # ---------------------------------------------------------

    feature_df = pd.DataFrame(new_features)

    result = pd.concat(
        [
            aqi.reset_index(drop=True),
            feature_df,
        ],
        axis=1,
    )

    # ---------------------------------------------------------
    # Save
    # ---------------------------------------------------------

    result.to_csv(
        OUTPUT_PATH,
        index=False,
    )

    print("\nDone!")
    print(f"Output : {OUTPUT_PATH}")
    print(f"Rows   : {len(result):,}")

    # ---------------------------------------------------------
    # Feature summary
    # ---------------------------------------------------------

    new_columns = [
        "downwind_fire_count_50km",
        "downwind_fire_count_100km",
        "downwind_fire_count_200km",
        "fire_intensity_50km",
        "fire_intensity_100km",
        "fire_intensity_200km",
        "closest_downwind_fire_km",
    ]

    print("\nNew dispersion features:")

    print(
        result[new_columns].describe()
    )


if __name__ == "__main__":
    main()