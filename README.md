# Export an administrative area

Open the live map: [https://uj1k.github.io/opensource-batasadministrasi/](https://uj1k.github.io/opensource-batas-administrasi/)

1. Open the map and wait for the administrative boundaries to appear.
2. Choose **Batas Provinsi** or **Batas Kecamatan** in the layer list. Only one boundary level is shown at a time.
3. Click an area in the active layer.
4. Check the area name in the **Selected Feature** popup, then choose **Download selected area**.
5. Wait for the export to finish. Choose **Cancel export** if you need to stop it.
6. Extract the downloaded ZIP. It contains the Shapefile components: `.shp`, `.shx`, `.dbf`, `.prj`, and `.cpg`.

Keep all five files together in the same folder when opening the `.shp` in GIS software. The projection is WGS 84 (EPSG:4326), and the `.cpg` file identifies the text encoding as UTF-8.

The **Batas Kecamatan** archive is downloaded from [release v1.0.0](https://github.com/UJ1K/opensource-batasadministrasi/releases/download/v1.0.0/kecamatan_admin.pmtiles) by the GitHub Pages workflow and served from the site itself. For local use, place `kecamatan_admin.pmtiles` in `public/` and set `VITE_SUBDISTRICT_PMTILES_URL` in `.env` to `http://localhost:5173/opensource-batasadministrasi/kecamatan_admin.pmtiles`.

If no area can be selected, make sure the chosen boundary archive has loaded. The export button appears in the popup after you click an area.
