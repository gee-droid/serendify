from flask import Flask, request, jsonify, redirect, session
import spotipy
from spotipy.oauth2 import SpotifyOAuth
from dotenv import load_dotenv
from shuffle import shuffle_playlist
import os

load_dotenv()

app = Flask(__name__)
app.secret_key = "serendify_secret"

def get_spotify():
    return spotipy.Spotify(auth_manager=SpotifyOAuth(
        client_id=os.getenv("SPOTIFY_CLIENT_ID"),
        client_secret=os.getenv("SPOTIFY_CLIENT_SECRET"),
        redirect_uri=os.getenv("SPOTIFY_REDIRECT_URI"),
        scope="playlist-read-private playlist-modify-public playlist-modify-private"
    ))

@app.route("/")
def home():
    return "Serendify is running!"

@app.route("/shuffle", methods=["POST"])
def shuffle():
    data = request.json
    playlist_url = data.get("playlist_url")
    
    sp = get_spotify()
    
    # Extract playlist ID from URL
    playlist_id = playlist_url.split("/")[-1].split("?")[0]
    
    # Fetch all songs
    results = sp.playlist_tracks(playlist_id)
    songs = []
    for item in results['items']:
        track = item['track']
        songs.append({
            "name": track['name'],
            "artist": track['artists'][0]['name'],
            "id": track['id']
        })
    
    # Shuffle fairly
    shuffled = shuffle_playlist(songs)
    
    # Get current user
    user = sp.current_user()
    
    # Create new playlist
    new_playlist = sp.user_playlist_create(
        user=user['id'],
        name="Serendified ✨",
        public=True,
        description="Fairly shuffled by Serendify"
    )
    
    # Add shuffled songs
    track_ids = ["spotify:track:" + song['id'] for song in shuffled]
    sp.playlist_add_items(new_playlist['id'], track_ids)
    
    return jsonify({
        "playlist_url": new_playlist['external_urls']['spotify'],
        "songs": shuffled
    })

if __name__ == "__main__":
    app.run(debug=True, port=5000)