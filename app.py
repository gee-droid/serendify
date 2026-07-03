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
        scope="playlist-read-private playlist-modify-public playlist-modify-private"
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
    return "Logged in! Now test /shuffle"

@app.route("/shuffle", methods=["POST"])
def shuffle():
    sp = get_spotify()
    if not sp:
        return jsonify({"error": "Not logged in"}), 401

    data = request.json
    playlist_url = data.get("playlist_url")
    playlist_id = playlist_url.split("/")[-1].split("?")[0]

    results = sp.playlist_tracks(playlist_id)
    songs = []
    for item in results['items']:
        track = item['track']
        songs.append({
            "name": track['name'],
            "artist": track['artists'][0]['name'],
            "id": track['id']
        })

    shuffled = shuffle_playlist(songs)

    user = sp.current_user()
    new_playlist = sp.user_playlist_create(
        user=user['id'],
        name="Serendified ✨",
        public=True,
        description="Fairly shuffled by Serendify"
    )

    track_ids = ["spotify:track:" + song['id'] for song in shuffled]
    sp.playlist_add_items(new_playlist['id'], track_ids)

    return jsonify({
        "playlist_url": new_playlist['external_urls']['spotify'],
        "songs": shuffled
    })
@app.route("/test-shuffle")
def test_shuffle():
    sp = get_spotify()
    if not sp:
        return redirect("/login")
    
    playlist_id = "4tw962vkBaTjUyw0ijPJDj"
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
        if not song_name or not song_artist or not song_id:
         continue
        songs.append({
        "name": song_name,
        "artist": song_artist,
        "id": song_id
    })
    shuffled = shuffle_playlist(songs)
    return jsonify({"songs": shuffled})

if __name__ == "__main__":
    app.run(debug=True, port=5000)