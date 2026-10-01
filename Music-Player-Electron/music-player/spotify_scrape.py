#!/usr/bin/env python3
"""
Usage:
  python spotify_scrape.py "https://open.spotify.com/playlist/XXXX"
  python spotify_scrape.py "https://open.spotify.com/track/XXXX"
  python spotify_scrape.py "https://open.spotify.com/intl-en/track/XXXX"
  python spotify_scrape.py "spotify:track:XXXX"

Prints a JSON array of { "title": "...", "artists": "..." }
"""
import sys
import json
import re
from urllib.parse import urlparse, parse_qs
from spotify_scraper import SpotifyClient


def normalize_spotify_url(raw: str) -> str:
    """Turn almost any Spotify share/link into a clean open.spotify.com URL."""
    raw = raw.strip()

    # spotify:track:ID  or  spotify:playlist:ID
    m = re.match(r"^spotify:(track|playlist):([a-zA-Z0-9]+)$", raw)
    if m:
        return f"https://open.spotify.com/{m.group(1)}/{m.group(2)}"

    # Already a normal URL – clean it
    try:
        u = urlparse(raw)
        if not u.scheme:
            raw = "https://" + raw
            u = urlparse(raw)

        # Accept open.spotify.com and *.spotify.com
        host = (u.hostname or "").lower()
        if "spotify.com" not in host:
            return raw  # leave it, let the later check fail

        path = u.path or ""

        # Extract type + ID even with locale prefixes:
        # /track/ID
        # /playlist/ID
        # /intl-en/track/ID
        # /intl-de/playlist/ID
        m = re.search(r"/(track|playlist)/([a-zA-Z0-9]+)", path)
        if m:
            kind, sid = m.group(1), m.group(2)
            return f"https://open.spotify.com/{kind}/{sid}"

        return raw
    except Exception:
        return raw


def track_to_dict(t) -> dict | None:
    if t is None:
        return None
    artists = ", ".join(a.name for a in (getattr(t, "artists", None) or []))
    title = getattr(t, "name", None) or ""
    if not title:
        return None
    return {"title": title, "artists": artists}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No Spotify URL given"}), file=sys.stderr)
        sys.exit(1)

    original = sys.argv[1].strip()
    url = normalize_spotify_url(original)

    try:
        with SpotifyClient() as client:
            tracks = []

            if "/playlist/" in url:
                playlist = client.get_playlist(url, max_tracks=None)
                for entry in playlist.tracks:
                    d = track_to_dict(getattr(entry, "track", None))
                    if d:
                        tracks.append(d)

            elif "/track/" in url:
                t = client.get_track(url)
                d = track_to_dict(t)
                if d:
                    tracks.append(d)

            else:
                print(
                    json.dumps({
                        "error": f"Not a Spotify playlist or track URL (got: {original})"
                    }),
                    file=sys.stderr,
                )
                sys.exit(1)

            print(json.dumps(tracks, ensure_ascii=False))

    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()