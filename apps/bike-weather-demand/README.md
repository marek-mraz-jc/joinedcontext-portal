# Bikes and the weather (Pyörät ja sää)

"Will there be a bike at my station?" For one city-bike station: its availability by hour of the week, how temperature and rain change it, and an estimate for the next 6 hours with its uncertainty.

Built with React 19, TypeScript, and a WebAssembly analysis engine compiled from Rust (`wasm-bindgen`). Runs completely in the browser as a static `ui` bundle without requiring server pods.

## Data sources

- **BikeHireDockingStation**: Current state and 7-day temporal history (`availableBikeNumber`) for the chosen station.
- **WeatherObserved**: Current road weather observations and 7-day temporal history (`temperature`, `precipitation`) from the nearest station within 10 km (calculated via haversine distance).

## Analysis engine

- Computes Europe/Helsinki hours of week (0..=167) accounting for EU daylight saving time transitions.
- Evaluates the baseline hour-of-week profile with fallback to day-hour averages.
- Fits the weather terms with the within-slot estimator: the residual bike count, the temperature and rain are each taken from their slot group's mean before the 3×3 least-squares fit, so the profile does not absorb weather effects that follow the time of day (a plain residual fit came out biased toward zero).
- Projects availability over the next 6 hours with an 80 % prediction interval (±1.28 σ), assuming the weather stays as last observed: the data holds no forecast.
- Reads one station's history only, through the SDK's temporal `id` parameter: a week of every station's minute-by-minute availability would be millions of points.

## Development

```bash
# Build the WebAssembly module
pnpm wasm

# Run development server
pnpm dev

# Run unit and integration tests
pnpm test

# Check types and produce production bundle
pnpm build

# Run Playwright responsive end-to-end tests
pnpm e2e
```
