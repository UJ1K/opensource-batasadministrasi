# Export an administrative area

1. Open the map and wait for the administrative boundaries to appear.
2. Click the province or other administrative area you want to export.
3. Check the area name in the **Selected Feature** popup, then choose **Download selected area**.
4. Wait for the export to finish. Choose **Cancel export** if you need to stop it.
5. Extract the downloaded ZIP. It contains the Shapefile components: `.shp`, `.shx`, `.dbf`, `.prj`, and `.cpg`.

Keep all five files together in the same folder when opening the `.shp` in GIS software. The projection is WGS 84 (EPSG:4326), and the `.cpg` file identifies the text encoding as UTF-8.

If no area can be selected, make sure the map boundaries have loaded. The export button is available in the popup after you click an area.
