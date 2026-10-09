import joblib
import pandas as pd

MODEL_PATH = "data/processed/unified_random_forest.joblib"
DATA_PATH = "data/processed/model_training_data.csv"

bundle = joblib.load(MODEL_PATH)

pipeline = bundle["pipeline"]
features = bundle["features"]

df = pd.read_csv(DATA_PATH)

# Pick one real observation as an inference example
sample = df.iloc[-1]

input_data = pd.DataFrame([{
    feature: sample[feature]
    for feature in features
}])

prediction = pipeline.predict(input_data)[0]

print("\nInput:")
print(input_data.to_dict(orient="records")[0])

print(f"\nPredicted PM2.5: {prediction:.2f} µg/m³")
print(f"Actual PM2.5:    {sample['pm25']:.2f} µg/m³")
