import pandas as pd

HIST = "data/processed/training_data_historical_dispersion.csv"
CURRENT = "data/processed/training_data_dispersion.csv"
OUTPUT = "data/processed/unified_training_data.csv"

COMMON = [
    "date",
    "location_id",
    "pm25",
    "latitude",
    "longitude",
    "wind_speed_kmh",
    "wind_direction_deg",
    "downwind_fire_count_50km",
    "downwind_fire_count_100km",
    "downwind_fire_count_200km",
    "fire_intensity_50km",
    "fire_intensity_100km",
    "fire_intensity_200km",
    "closest_downwind_fire_km",
]

hist = pd.read_csv(HIST)
current = pd.read_csv(CURRENT)

# Match historical column names to current schema
hist = hist.rename(columns={
    "mean": "pm25",
    "wind_speed_mean": "wind_speed_kmh",
    "wind_direction_mean": "wind_direction_deg",
})

# Keep only features common to both datasets
hist = hist[COMMON]
current = current[COMMON]

# Consistent date type
hist["date"] = pd.to_datetime(hist["date"])
current["date"] = pd.to_datetime(current["date"])

# Combine
df = pd.concat([hist, current], ignore_index=True)

# Sort chronologically
df = df.sort_values(["location_id", "date"]).reset_index(drop=True)

# Remove accidental duplicates
before = len(df)
df = df.drop_duplicates(
    subset=["location_id", "date"],
    keep="first"
)
after = len(df)

# Save
df.to_csv(OUTPUT, index=False)

print(f"Historical rows:    {len(hist)}")
print(f"Current rows:       {len(current)}")
print(f"Combined rows:      {before}")
print(f"Duplicates removed: {before - after}")
print(f"Final rows:         {after}")
print(f"Stations:           {df['location_id'].nunique()}")
print(f"Date range:         {df['date'].min().date()} to {df['date'].max().date()}")

print("\nMissing values:")
print(df.isnull().sum())

print(f"\nSaved: {OUTPUT}")
