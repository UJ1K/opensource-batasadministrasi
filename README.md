# Batas Administrasi Indonesia

An interactive Indonesia administrative-boundary viewer. It opens with an animated globe, then displays a zoomable map with administrative vector tiles from a PMTiles archive.

## Features

- Animated COBE globe intro focused on Indonesia
- MapLibre map with Esri World Imagery
- PMTiles administrative boundary layer
- Light and dark map styles, layer visibility, zoom controls, and feature inspection

## Requirements

- Node.js (LTS recommended) and npm
- A PMTiles archive hosted at a URL reachable by the browser
- A storage server that supports HTTP byte-range requests (required by PMTiles)

## Run locally

Clone the repository and enter its folder:

```bash
git clone https://github.com/UJ1K/opensource-batasadministrasi.git
cd opensource-batasadministrasi
```

Install dependencies:

```bash
npm install
```

Create a local environment file from the example. On macOS/Linux:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Open `.env` and set the PMTiles archive URL:

```env
VITE_PMTILES_URL=https://your-storage-host/path/indonesia-admin.pmtiles
```

Start the development server:

```bash
npm run dev
```

Open the local URL printed by Vite (usually `http://localhost:5173`). Restart the dev server after changing `.env`.

## Build for deployment

```bash
npm run build
npm run preview
```

The production files are written to `dist/`. Set `VITE_PMTILES_URL` in the deployment platform's build environment before building.

## Data and configuration

`VITE_PMTILES_URL` points to the PMTiles archive. `.env` is excluded from Git; `.env.example` is a template. Vite embeds `VITE_` variables in browser code at build time, so the URL is visible to visitors. Do not put passwords, service-role keys, or other secrets in this variable. Use a public, read-only storage URL for the archive.

The map and browser must be able to reach the archive directly. For a locally hosted Supabase Storage URL such as `http://127.0.0.1:54321/...`, other users and deployed sites cannot reach your computer; use a reachable hosted endpoint for those cases. Configure storage CORS to allow the site origin and ensure byte-range requests work.

## Tech stack

- Vite
- MapLibre GL JS
- PMTiles
- COBE

