from flask import Flask, request, jsonify, redirect, session
import spotipy
from spotipy.oauth2 import SpotifyOAuth
from dotenv import load_dotenv
from shuffle import shuffle_playlist
import os

load_dotenv()

app = Flask(__name__)
app.secret_key = "serendify_secret"

def get_spotify_oauth():
    return SpotifyOAuth(
        client_id=os.getenv("SPOTIFY_CLIENT_ID"),
        client_secret=os.getenv("SPOTIFY_CLIENT_SECRET"),
        redirect_uri=os.getenv("SPOTIFY_REDIRECT_URI"),
        scope="ugc-image-upload playlist-read-private playlist-read-collaborative playlist-modify-private playlist-modify-public streaming user-read-playback-state user-modify-playback-state user-read-currently-playing"
    )

def get_spotify():
    token_info = session.get("token")
    if not token_info:
        return None
    sp_oauth = get_spotify_oauth()
    if sp_oauth.is_token_expired(token_info):
        token_info = sp_oauth.refresh_access_token(token_info['refresh_token'])
        session["token"] = token_info
    return spotipy.Spotify(auth=token_info['access_token'])

def get_access_token():
    token_info = session.get("token")
    if not token_info:
        return None
    return token_info['access_token']

def fetch_songs(sp, playlist_id):
    results = sp.playlist_tracks(playlist_id)
    songs = []
    for item in results['items']:
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
    session["token"] = token_info
    return "Logged in!"

@app.route("/token")
def token():
    access_token = get_access_token()
    if not access_token:
        return jsonify({"error": "Not logged in"}), 401
    return jsonify({"access_token": access_token})

@app.route("/shuffle", methods=["POST"])
def shuffle():
    sp = get_spotify()
    if not sp:
        return jsonify({"error": "Not logged in"}), 401

    data = request.json
    playlist_url = data.get("playlist_url")
    playlist_id = playlist_url.split("/")[-1].split("?")[0]

    songs = fetch_songs(sp, playlist_id)
    if not songs:
        return jsonify({"error": "No songs found"}), 404

    shuffled = shuffle_playlist(songs)

    return jsonify({
        "songs": shuffled
    })

if __name__ == "__main__":
    app.run(debug=True, port=5000)