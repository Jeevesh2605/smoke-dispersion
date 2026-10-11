"""
Recompute the Random Forest metrics and two simple baselines on the same
rows, for the date-based splits used by train_unified_model.py, and audit
the setup so the comparison can be trusted.

Baselines
---------
previous-reading  : predict today's PM2.5 with the previous day's reading
                    (the pm25_lag_1 column).
three-day average : predict today's PM2.5 with the mean of the previous
                    three calendar days at the same station.

Metrics are computed only on rows where every method has its inputs, so the
three rows of each table are directly comparable.

Audit (printed first)
---------------------
1. Which data and model files were loaded (path, size, modified time, hash).
2. Whether the saved model matches the configuration in
   scripts/train_unified_model.py (features, hyper-parameters, split dates).
3. Whether the train / validation / test splits are chronological and
   do not overlap.
4. Random Forest metrics on every row of each split, including the training
   rows (in-sample), which should match what train_unified_model.py prints.
5. Whether the lag columns agree with calendar-day lookups on the rows used.
6. Leakage heuristics: feature/target correlations on the test split.

Run from the repository root:
    python scripts/evaluate_baselines.py
    python scripts/evaluate_baselines.py --data PATH.csv --model PATH.joblib
"""

import argparse
import ast
import datetime
import hashlib
import os
import re
import sys

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

DEFAULT_DATA = "data/processed/model_training_data.csv"
DEFAULT_MODEL = "data/processed/unified_random_forest.joblib"
TRAIN_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "train_unified_model.py")

# (start inclusive, end exclusive); None = open-ended.
# Checked against train_unified_model.py in the audit below.
TRAIN_END = "2025-01-01"
SPLITS = {
    "validation": ("2025-01-01", "2025-07-01"),
    "test": ("2025-07-01", None),
}

failures = []


def report(ok, label, detail=""):
    """Print one audit line and remember hard failures."""
    status = "OK      " if ok else "MISMATCH"
    print(f"  [{status}] {label}" + (f" - {detail}" if detail else ""))
    if not ok:
        failures.append(label)


def info(label, detail=""):
    print(f"  [INFO    ] {label}" + (f" - {detail}" if detail else ""))


def file_info(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    stat = os.stat(path)
    modified = datetime.datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M")
    return (
        f"{os.path.abspath(path)} | {stat.st_size / 1e6:.1f} MB | "
        f"modified {modified} | sha256 {digest.hexdigest()[:12]}"
    )


def read_training_config(path):
    """Read FEATURES, RandomForestRegressor arguments and date literals from the training script."""
    tree = ast.parse(open(path, encoding="utf-8").read())
    config = {"features": None, "rf": {}, "dates": set()}
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "FEATURES" for t in node.targets
        ):
            config["features"] = ast.literal_eval(node.value)
        elif isinstance(node, ast.Call) and getattr(node.func, "id", None) == "RandomForestRegressor":
            config["rf"] = {k.arg: ast.literal_eval(k.value) for k in node.keywords}
        elif (
            isinstance(node, ast.Constant)
            and isinstance(node.value, str)
            and re.fullmatch(r"\d{4}-\d{2}-\d{2}", node.value)
        ):
            config["dates"].add(node.value)
    return config


def add_previous_days(df, days):
    """Add pm25_prev_<days>: PM2.5 at the same station `days` calendar days earlier."""
    lookup = df[["location_id", "date", "pm25"]].copy()
    lookup["date"] = lookup["date"] + pd.DateOffset(days=days)
    lookup = lookup.rename(columns={"pm25": f"pm25_prev_{days}"})
    return df.merge(lookup, on=["location_id", "date"], how="left")


def metrics(y_true, y_pred):
    mae = mean_absolute_error(y_true, y_pred)
    rmse = float(np.sqrt(mean_squared_error(y_true, y_pred)))
    r2 = r2_score(y_true, y_pred)
    return mae, rmse, r2


def split_mask(df, start, end):
    mask = df["date"] >= start
    if end is not None:
        mask &= df["date"] < end
    return mask


def audit(df, pipeline, features, target, data_path, model_path):
    print("AUDIT")

    # 1. files loaded
    print("1. Files loaded")
    print(f"   data : {file_info(data_path)}")
    print(f"   model: {file_info(model_path)}")
    print(f"   rows : {len(df)}, stations: {df['location_id'].nunique()}, "
          f"dates: {df['date'].min().date()} to {df['date'].max().date()}")

    # 2. saved model vs training script
    print("2. Saved model vs scripts/train_unified_model.py")
    if os.path.exists(TRAIN_SCRIPT):
        config = read_training_config(TRAIN_SCRIPT)
        report(config["features"] == features, "bundle features equal FEATURES in the training script")
        report(
            list(getattr(pipeline, "feature_names_in_", features)) == features,
            "pipeline input columns equal the bundle features",
        )
        report(target not in features, "target column is not among the features")
        model_params = pipeline.named_steps["model"].get_params()
        for key, expected in config["rf"].items():
            if key == "n_jobs":
                continue
            report(model_params.get(key) == expected, f"RandomForest {key} = {expected}",
                   f"saved model has {model_params.get(key)}")
        wanted = {TRAIN_END} | {d for pair in SPLITS.values() for d in pair if d}
        report(config["dates"] == wanted, "split dates equal those in the training script",
               f"script has {sorted(config['dates'])}, this file uses {sorted(wanted)}")
    else:
        info("training script not found next to this file; checks in section 2 skipped")

    # 3. chronology
    print("3. Splits are chronological and do not overlap")
    train = df[df["date"] < TRAIN_END]
    val = df[split_mask(df, *SPLITS["validation"])]
    test = df[split_mask(df, *SPLITS["test"])]
    for name, part in (("train", train), ("validation", val), ("test", test)):
        info(f"{name}: {len(part)} rows", f"{part['date'].min().date()} to {part['date'].max().date()}")
    report(train["date"].max() < val["date"].min() <= val["date"].max() < test["date"].min(),
           "train < validation < test by date")
    report(len(train) + len(val) + len(test) == len(df), "every row belongs to exactly one split")

    # 4. RF metrics on every row of each split
    print("4. Random Forest on every row of each split (compare with train_unified_model.py output)")
    for name, part in (("train (in-sample, reference only)", train), ("validation", val), ("test", test)):
        mae, rmse, r2 = metrics(part[target], pipeline.predict(part[features]))
        info(f"{name}: n={len(part)}", f"MAE {mae:.2f} | RMSE {rmse:.2f} | R2 {r2:.3f}")
    print("   A training R2 far above validation/test is normal for a Random Forest;")
    print("   a validation/test score as high as the training score would be suspicious.")

    # 5. lag columns vs calendar days, on the rows the tables use
    print("5. Lag columns vs calendar days (rows used in the tables)")
    usable = df[df["baseline_avg3"].notna()]
    for lag in (1, 3):
        col, prev = f"pm25_lag_{lag}", f"pm25_prev_{lag}"
        bad = int((~np.isclose(usable[col], usable[prev])).sum())
        report(bad == 0, f"{col} equals PM2.5 exactly {lag} calendar day(s) earlier",
               f"{bad} of {len(usable)} rows differ")
    for name, part in (("validation", val), ("test", test)):
        gap = int((~np.isclose(part["pm25_lag_7"], part["pm25_prev_7"])).sum())
        info(f"{name}: pm25_lag_7 is not the calendar d-7 reading on {gap} of {len(part)} rows",
             "row-based lag, still past data, so not leakage")

    # 6. leakage heuristics
    print("6. Leakage heuristics on the test split")
    numeric = [f for f in features if f != "location_id"]
    corr = test[numeric + [target]].corr()[target].drop(target)
    for name, value in corr.reindex(corr.abs().sort_values(ascending=False).index).head(5).items():
        info(f"correlation with {target}: {name}", f"{value:+.2f}")
    report(float(corr.abs().max()) < 0.95, "no feature is almost identical to the target (|r| < 0.95)")
    print()


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--data", default=DEFAULT_DATA)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    args = parser.parse_args()

    df = pd.read_csv(args.data, parse_dates=["date"])
    if df.duplicated(["location_id", "date"]).any():
        raise SystemExit("Duplicate (location_id, date) rows found; cannot align previous days.")

    bundle = joblib.load(args.model)
    pipeline, features, target = bundle["pipeline"], bundle["features"], bundle["target"]

    for days in (1, 2, 3, 7):
        df = add_previous_days(df, days)

    prev_cols = [f"pm25_prev_{d}" for d in (1, 2, 3)]
    df["baseline_previous"] = df["pm25_lag_1"]
    df["baseline_avg3"] = df[prev_cols].mean(axis=1, skipna=False)

    audit(df, pipeline, features, target, args.data, args.model)

    for name, (start, end) in SPLITS.items():
        in_split = df[split_mask(df, start, end)]
        usable = in_split[in_split["baseline_avg3"].notna()]
        skipped = len(in_split) - len(usable)

        label = f"{start} to {end}" if end else f"from {start}"
        print(f"{name.upper()} ({label}): {len(usable)} rows used, {skipped} skipped (missing previous day)")
        if usable.empty:
            print("  No rows in this split.")
            continue

        y = usable[target]
        rows = [
            ("Random Forest (unified model)", pipeline.predict(usable[features])),
            ("Previous-reading baseline", usable["baseline_previous"]),
            ("Three-day lag-average baseline", usable["baseline_avg3"]),
        ]

        print("| Model | MAE (µg/m³) | RMSE (µg/m³) | R² |")
        print("|:--|--:|--:|--:|")
        for label_, pred in rows:
            mae, rmse, r2 = metrics(y, pred)
            print(f"| {label_} | {mae:.2f} | {rmse:.2f} | {r2:.3f} |")
        print()

    if failures:
        print(f"AUDIT RESULT: {len(failures)} check(s) failed: {', '.join(failures)}")
        sys.exit(1)
    print("AUDIT RESULT: all checks passed")


if __name__ == "__main__":
    main()