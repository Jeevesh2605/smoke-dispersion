from pathlib import Path
import pandas as pd
from strands import tool

PROJECT_ROOT = Path(__file__).resolve().parents[2]
LOCATION_FILE = PROJECT_ROOT / "data/processed/location_metadata.csv"


@tool
def get_location_metadata(location_id: int) -> dict:
    """Get the name and coordinates of a Delhi-NCR monitoring location."""

    df = pd.read_csv(LOCATION_FILE)

    row = df[df["location_id"] == location_id]

    if row.empty:
        return {"error": f"Location {location_id} not found"}

    record = row.iloc[0]

    return {
        "location_id": int(record["location_id"]),
        "location_name": record["location_name"],
        "latitude": float(record["latitude"]),
        "longitude": float(record["longitude"]),
    }
