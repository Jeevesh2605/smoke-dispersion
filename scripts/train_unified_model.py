import pandas as pd
import numpy as np

from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.preprocessing import OneHotEncoder
from sklearn.compose import ColumnTransformer
from sklearn.pipeline import Pipeline
import joblib

INPUT = "data/processed/model_training_data.csv"
MODEL_OUTPUT = "data/processed/unified_random_forest.joblib"

df = pd.read_csv(INPUT, parse_dates=["date"])

FEATURES = [
    "pm25_lag_1",
    "pm25_lag_3",
    "pm25_lag_7",
    "wind_speed_kmh",
    "wind_direction_deg",
    "downwind_fire_count_50km",
    "downwind_fire_count_100km",
    "downwind_fire_count_200km",
    "fire_intensity_50km",
    "fire_intensity_100km",
    "fire_intensity_200km",
    "closest_downwind_fire_km",
    "location_id",
]

TARGET = "pm25"

train = df[df["date"] < "2025-01-01"]
val = df[(df["date"] >= "2025-01-01") & (df["date"] < "2025-07-01")]
test = df[df["date"] >= "2025-07-01"]

X_train = train[FEATURES]
y_train = train[TARGET]

X_val = val[FEATURES]
y_val = val[TARGET]

X_test = test[FEATURES]
y_test = test[TARGET]

categorical = ["location_id"]
numeric = [c for c in FEATURES if c not in categorical]

preprocessor = ColumnTransformer(
    transformers=[
        ("cat", OneHotEncoder(handle_unknown="ignore"), categorical),
        ("num", "passthrough", numeric),
    ]
)

model = RandomForestRegressor(
    n_estimators=300,
    max_depth=18,
    min_samples_leaf=3,
    random_state=42,
    n_jobs=-1,
)

pipeline = Pipeline([
    ("preprocessor", preprocessor),
    ("model", model),
])

print("Training...")
pipeline.fit(X_train, y_train)

def evaluate(name, X, y):
    pred = pipeline.predict(X)

    mae = mean_absolute_error(y, pred)
    rmse = np.sqrt(mean_squared_error(y, pred))
    r2 = r2_score(y, pred)

    print(f"\n{name}")
    print(f"MAE:  {mae:.2f}")
    print(f"RMSE: {rmse:.2f}")
    print(f"R²:   {r2:.4f}")

    return pred

train_pred = evaluate("TRAIN", X_train, y_train)
val_pred = evaluate("VALIDATION", X_val, y_val)
test_pred = evaluate("TEST", X_test, y_test)

# Extreme-event performance
print("\nExtreme-event performance:")

for threshold in [100, 200, 500, 1000]:
    mask = y_test >= threshold

    if mask.sum() == 0:
        continue

    mae = mean_absolute_error(y_test[mask], test_pred[mask])

    print(
        f"PM2.5 >= {threshold}: "
        f"{mask.sum()} samples, "
        f"MAE = {mae:.2f}"
    )

joblib.dump(
    {
        "pipeline": pipeline,
        "features": FEATURES,
        "target": TARGET,
    },
    MODEL_OUTPUT,
)

print(f"\nModel saved to: {MODEL_OUTPUT}")
