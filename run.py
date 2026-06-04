"""Run the full Apple Health analysis pipeline end-to-end."""
import runpy
import os

HERE = os.path.dirname(os.path.abspath(__file__))
STEPS = [
    "parse_export.py",
    "parse_gpx.py",
    "build_routes_map.py",
    "build_dashboard.py",
]

for step in STEPS:
    print(f"\n=== {step} ===")
    runpy.run_path(os.path.join(HERE, "src", step), run_name="__main__")

print("\nDone. Open output/dashboard.html in your browser.")
