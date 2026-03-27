# Sunny Dublin (MVP)

Map of Dublin pubs with a first-pass estimate of *when the pub’s front is sunny*, using:

- Sun position (azimuth + altitude) per hour
- A saved or inferred “front bearing” for each pub
- Public forecast data (Open-Meteo hourly cloud cover)
- A free street-shadow heuristic so narrow streets are less over-optimistic

This is still an MVP: it does not do full 3D raycasting, and tree cover / exact facade geometry can still make real-world sun differ from the estimate.

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

## How “sunny front” is calculated (current)

For each 10-minute timestamp (next 48h):

1. Sun altitude must be above the horizon (`altitude > 0°`)
2. Sun bearing must be within the pub front hemisphere (default: within 90° of the front bearing)
3. Cloud cover must be ≤ 40%
4. Sun altitude must also clear a pub-specific street-shadow threshold (`shadeClearanceDeg`)

## Pub import / scaling to “all pubs”

The app loads pubs from `public/pubs.json` (and falls back to a small seed list in `src/data/pubs.ts` if that file is missing/invalid).

To pull Dublin pubs/bars from OpenStreetMap into `public/pubs.json`:

```bash
npm run import:pubs
```

The importer now:

- queries Dublin in smaller tiles so Overpass is less likely to fail
- includes venues tagged as either `amenity=pub` or `amenity=bar`
- merges in a small curated supplement for well-known Dublin pubs that OSM can miss
- precomputes `frontBearingDeg`
- precomputes `shadeClearanceDeg`

## Roadmap to Shadowmap-like results

1. Persist better display anchors per pub (entrance / facade midpoint when available)
2. Add precomputed OSM building context without live Overpass dependency in the app
3. Build a spatial index and raycast from pub facade points toward the sun vector
4. Compute “front is in sun” at finer resolution (e.g. 5–10 minutes), not just hourly
