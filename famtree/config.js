/**
 * Paste your Google Sheet "Publish to web" CSV URL below.
 *
 * How to get it:
 * 1. Open your sheet → File → Share → Publish to web
 * 2. Choose the "people" tab → Comma-separated values (.csv)
 * 3. Copy the URL and paste it here
 *
 * Leave empty to use people.tsv only (local / offline).
 */
export const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQT34460srhoe8p5asuowblonY9rxHsHI8vRKDehNYNxS4TEnLs7WZOmWC6EmOpiph7Lm84S0QfmXyp/pub?output=csv";

/** Used when SHEET_CSV_URL is empty or the sheet cannot be loaded */
export const FALLBACK_DATA_URL = "people.tsv";
