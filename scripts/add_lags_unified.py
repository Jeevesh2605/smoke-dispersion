import pandas as pd

INPUT = "data/processed/unified_training_data.csv"
OUTPUT = "data/processed/model_training_data.csv"

df = pd.read_csv(INPUT, parse_dates=["date"])

df = df.sort_values(["location_id", "date"]).reset_index(drop=True)

# PM2.5 historical lags per station
for lag in [1, 3, 7]:
    df[f"pm25_lag_{lag}"] = (
        df.groupby("location_id")["pm25"]
        .shift(lag)
    )

print("Rows before lag filtering:", len(df))

print("\nMissing lag values:")
print(df[["pm25_lag_1", "pm25_lag_3", "pm25_lag_7"]].isna().sum())

# Keep rows where all required lag features exist
df = df.dropna(
    subset=["pm25_lag_1", "pm25_lag_3", "pm25_lag_7"]
).reset_index(drop=True)

# Missing closest fire means no qualifying downwind fire.
# Use a large sentinel value so the model can distinguish it from nearby fires.
df["closest_downwind_fire_km"] = (
    df["closest_downwind_fire_km"].fillna(999.0)
)

df.to_csv(OUTPUT, index=False)

print("\nRows after lag filtering:", len(df))
print("Stations:", df["location_id"].nunique())
print("Date range:", df["date"].min().date(), "to", df["date"].max().date())

print("\nRemaining missing values:")
print(df.isna().sum())

print(f"\nSaved: {OUTPUT}")
