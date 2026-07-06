from flask import Flask, request, jsonify, redirect, session
import spotipy
from spotipy.oauth2 import SpotifyOAuth
from dotenv import load_dotenv
from shuffle import shuffle_playlist
import os
from flask_cors import CORS

load_dotenv()

app = Flask(__name__)
app.secret_key = "serendify_secret"
CORS(app)


def get_spotify_oauth():
    return SpotifyOAuth(
        client_id=os.getenv("SPOTIFY_CLIENT_ID"),
        client_secret=os.getenv("SPOTIFY_CLIENT_SECRET"),
        redirect_uri=os.getenv("SPOTIFY_REDIRECT_URI"),
        scope="ugc-image-upload playlist-read-private playlist-read-collaborative playlist-modify-private playlist-modify-public streaming user-read-playback-state user-modify-playback-state user-read-currently-playing user-read-email user-read-private"
    )


def fetch_songs(access_token, playlist_id):
    sp = spotipy.Spotify(auth=access_token)
    songs = []
    limit = 100
    offset = 0

    while True:
        results = sp.playlist_tracks(playlist_id, limit=limit, offset=offset)
        items = results.get('items', [])

        if not items:
            break

        for item in items:
            if not item:
                continue
            track = item.get('item') or item.get('track')
            if not track:
                continue
            song_name = track.get('name')
            song_artist = track.get('artists', [{}])[0].get('name')
            song_id = track.get('id')
            song_image = track.get('album', {}).get('images', [{}])[0].get('url')
            if not song_name or not song_artist or not song_id:
                continue
            songs.append({
                "name": song_name,
                "artist": song_artist,
                "id": song_id,
                "image": song_image
            })

        # Stop once we've fetched everything Spotify says exists
        if results.get('next') is None:
            break

        offset += limit

    return songs


@app.route("/")
def home():
    return "Serendify is running!"


@app.route("/login")
def login():
    auth_url = get_spotify_oauth().get_authorize_url()
    return redirect(auth_url)


@app.route("/callback")
def callback():
    code = request.args.get("code")
    token_info = get_spotify_oauth().get_access_token(code)
    access_token = token_info['access_token']
    refresh_token = token_info['refresh_token']
    expires_in = token_info['expires_in']
    return redirect(
        f"http://localhost:3000"
        f"?access_token={access_token}"
        f"&refresh_token={refresh_token}"
        f"&expires_in={expires_in}"
    )


@app.route("/refresh_token")
def refresh_token_route():
    refresh_token = request.args.get("refresh_token")
    if not refresh_token:
        return jsonify({"error": "Missing refresh_token"}), 400

    try:
        token_info = get_spotify_oauth().refresh_access_token(refresh_token)
    except Exception as e:
        return jsonify({"error": f"Could not refresh token: {str(e)}"}), 400

    return jsonify({
        "access_token": token_info["access_token"],
        # Spotify doesn't always return a new refresh_token — if it
        # doesn't, the old one is still valid and reusable.
        "refresh_token": token_info.get("refresh_token", refresh_token),
        "expires_in": token_info["expires_in"]
    })


@app.route("/shuffle", methods=["POST"])
def shuffle():
    auth_header = request.headers.get("Authorization")
    if not auth_header:
        return jsonify({"error": "Not logged in"}), 401

    access_token = auth_header.split(" ")[1]

    data = request.json
    playlist_url = data.get("playlist_url")
    playlist_id = playlist_url.split("/")[-1].split("?")[0]

    try:
        songs = fetch_songs(access_token, playlist_id)
    except Exception as e:
        return jsonify({"error": f"Could not fetch playlist: {str(e)}"}), 400

    if not songs:
        return jsonify({"error": "No songs found"}), 404

    shuffled = shuffle_playlist(songs)

    return jsonify({"songs": shuffled})


if __name__ == "__main__":
    app.run(debug=True, port=5000)