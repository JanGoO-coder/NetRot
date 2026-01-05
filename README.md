# NetRot - Netflix Ratings Overlay

This Chrome extension overlays IMDb and Rotten Tomatoes ratings on Netflix movie cards.

## Installation

1.  Clone or download this repository.
2.  Open Chrome and go to `chrome://extensions`.
3.  Enable "Developer mode" in the top right.
4.  Click "Load unpacked" and select the `NetRot` directory (the folder containing `manifest.json`).

## Setup

1.  This extension relies on the OMDB API.
2.  Get a free API key from [omdbapi.com](http://www.omdbapi.com/apikey.aspx).
3.  Click the NetRot extension icon in your toolbar.
4.  Enter your API Key and click "Save Settings".

## Usage

browse Netflix as usual. Ratings will appear on the top-right of movie cards when you hover over them. Hovering allows you to see the details.

## Development

- `manifest.json`: Configuration.
- `content.js`: Handles DOM manipulation (finding movies, injecting badges).
- `background.js`: Handles API requests to OMDB (to avoid CORS issues in content scripts, though OMDB supports CORS, this is safer).
- `utils.js`: Helper functions.

## Troubleshooting

- **No Ratings?** Check if you added your API key in the popup.
- **Wrong Movie?** The search is based on text matching. Sometimes Netflix titles differ from OMDB/IMDb official titles.
